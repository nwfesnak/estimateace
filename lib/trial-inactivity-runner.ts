/**
 * Daily runner for the inactive-trial policy (see lib/trial-inactivity.ts).
 * All I/O goes through `TrialInactivityDeps` so the whole flow is unit-tested with fakes.
 *
 * Idempotency:
 *  - one open cycle per user (unique partial index); the row is created BEFORE the
 *    warning is sent and the Resend Idempotency-Key is `trial-warning/<cycle id>`.
 *  - the export email uses `trial-export/<cycle id>`; deletion runs only after
 *    export_sent_at is stored, and is retried daily until it succeeds.
 *  - dry-run computes the same plan and writes / sends nothing.
 */
import {
  decideInactivityAction,
  TRIAL_INACTIVITY_POLICY,
  type InactivityAction,
  type InactivityCandidate,
  type InactivityCycle,
} from '@/lib/trial-inactivity';

export type TrialInactivityDeps = {
  now: () => Date;
  listCandidates: () => Promise<InactivityCandidate[]>;
  listOpenCycles: () => Promise<InactivityCycle[]>;
  createCycle: (userId: string, lastActiveAt: string) => Promise<InactivityCycle>;
  updateCycle: (id: string, patch: Partial<Record<string, unknown>>) => Promise<void>;
  /** Re-check with Stripe right before export/deletion: false when anything was paid. */
  confirmUnpaidTrial: (c: InactivityCandidate) => Promise<{ ok: boolean; reason?: string }>;
  sendWarning: (c: InactivityCandidate, cycle: InactivityCycle, deleteAfter: string) => Promise<{ ok: boolean; id?: string; error?: string }>;
  /** Build + upload the export, email it. ok only when Resend accepted the email. */
  sendExport: (
    c: InactivityCandidate,
    cycle: InactivityCycle
  ) => Promise<{ ok: boolean; id?: string; error?: string; prefix?: string; expiresAt?: string }>;
  deleteAccount: (userId: string) => Promise<{ ok: boolean; error?: string }>;
  /** Remove export copies whose links expired (bucket housekeeping). */
  purgeExpiredExports: () => Promise<number>;
};

export type PlanEntry = {
  user: string; // first 8 chars only (logs)
  offer: string | null;
  inactiveDays: number | null;
  action: InactivityAction['action'];
  detail?: string;
};

export type TrialInactivityReport = {
  dryRun: boolean;
  candidates: number;
  openCycles: number;
  counts: Record<'warn' | 'wait' | 'export_and_delete' | 'delete' | 'clear' | 'none', number>;
  done: { warned: number; exported: number; deleted: number; cleared: number; exportsPurged: number };
  errors: string[];
  plan: PlanEntry[];
};

const short = (id: string) => String(id || '').slice(0, 8);

export async function runTrialInactivity(
  deps: TrialInactivityDeps,
  opts: { dryRun: boolean; maxExportsPerRun?: number; maxWarningsPerRun?: number }
): Promise<TrialInactivityReport> {
  const now = deps.now();
  const report: TrialInactivityReport = {
    dryRun: opts.dryRun,
    candidates: 0,
    openCycles: 0,
    counts: { warn: 0, wait: 0, export_and_delete: 0, delete: 0, clear: 0, none: 0 },
    done: { warned: 0, exported: 0, deleted: 0, cleared: 0, exportsPurged: 0 },
    errors: [],
    plan: [],
  };
  const maxExports = Math.max(0, opts.maxExportsPerRun ?? 3);
  const maxWarnings = Math.max(0, opts.maxWarningsPerRun ?? 50);

  const [candidates, cycles] = await Promise.all([deps.listCandidates(), deps.listOpenCycles()]);
  report.candidates = candidates.length;
  report.openCycles = cycles.length;
  const byUser = new Map(candidates.map((c) => [c.user_id, c]));
  const cycleByUser = new Map(cycles.map((c) => [c.user_id, c]));
  const userIds = Array.from(new Set([...byUser.keys(), ...cycleByUser.keys()]));

  let exportsRun = 0;
  let warningsRun = 0;

  for (const userId of userIds) {
    const cand = byUser.get(userId) || null;
    const cycle = cycleByUser.get(userId) || null;
    const decision = decideInactivityAction(cand, cycle, now, TRIAL_INACTIVITY_POLICY);
    report.counts[decision.action === 'warn' ? 'warn' : decision.action]++;
    report.plan.push({
      user: short(userId),
      offer: cand?.signup_offer ?? null,
      inactiveDays: 'inactiveDays' in decision ? decision.inactiveDays : null,
      action: decision.action,
      detail: 'deleteAfter' in decision ? decision.deleteAfter : 'reason' in decision ? decision.reason : undefined,
    });
    if (opts.dryRun || decision.action === 'none' || decision.action === 'wait') continue;

    try {
      if (decision.action === 'clear' && cycle) {
        await deps.updateCycle(cycle.id, {
          cleared_at: now.toISOString(),
          last_error: decision.reason === 'signed_in' ? null : 'no longer an inactive unpaid trial',
        });
        report.done.cleared++;
        continue;
      }

      if (!cand) continue;

      if (decision.action === 'warn') {
        if (warningsRun >= maxWarnings) continue;
        warningsRun++;
        const row = cycle || (await deps.createCycle(userId, cand.last_active_at));
        const sent = await deps.sendWarning(cand, row, decision.deleteAfter);
        if (!sent.ok) {
          await deps.updateCycle(row.id, { attempts: (row.attempts || 0) + 1, last_error: `warning: ${sent.error || 'send failed'}` });
          report.errors.push(`${short(userId)} warning: ${sent.error || 'send failed'}`);
          continue;
        }
        await deps.updateCycle(row.id, {
          warning_sent_at: now.toISOString(),
          warning_email_id: sent.id || null,
          last_active_at: cand.last_active_at,
          last_error: null,
        });
        report.done.warned++;
        continue;
      }

      if (!cycle) continue;

      if (decision.action === 'export_and_delete' || decision.action === 'delete') {
        // Never delete a paying customer: re-check Stripe right before acting.
        const paid = await deps.confirmUnpaidTrial(cand);
        if (!paid.ok) {
          await deps.updateCycle(cycle.id, { cleared_at: now.toISOString(), last_error: `skipped: ${paid.reason || 'paid'}` });
          report.done.cleared++;
          continue;
        }
      }

      if (decision.action === 'export_and_delete') {
        if (exportsRun >= maxExports) continue; // the rest go tomorrow
        exportsRun++;
        const exp = await deps.sendExport(cand, cycle);
        if (!exp.ok) {
          await deps.updateCycle(cycle.id, { attempts: (cycle.attempts || 0) + 1, last_error: `export: ${exp.error || 'failed'}` });
          report.errors.push(`${short(userId)} export: ${exp.error || 'failed'}`);
          continue; // no deletion without a confirmed export email
        }
        await deps.updateCycle(cycle.id, {
          export_sent_at: now.toISOString(),
          export_email_id: exp.id || null,
          export_prefix: exp.prefix || null,
          export_expires_at: exp.expiresAt || null,
          last_error: null,
        });
        report.done.exported++;
      }

      // export_and_delete (export just confirmed) or delete (export confirmed earlier).
      const del = await deps.deleteAccount(userId);
      if (!del.ok) {
        await deps.updateCycle(cycle.id, { attempts: (cycle.attempts || 0) + 1, last_error: `delete: ${del.error || 'failed'}` });
        report.errors.push(`${short(userId)} delete: ${del.error || 'failed'}`);
        continue;
      }
      await deps.updateCycle(cycle.id, { deleted_at: now.toISOString(), last_error: null });
      report.done.deleted++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      report.errors.push(`${short(userId)}: ${msg}`);
      if (cycle) await deps.updateCycle(cycle.id, { last_error: msg.slice(0, 500) }).catch(() => {});
    }
  }

  if (!opts.dryRun) {
    try {
      report.done.exportsPurged = await deps.purgeExpiredExports();
    } catch (e) {
      report.errors.push(`export housekeeping: ${e instanceof Error ? e.message : e}`);
    }
  }
  return report;
}
