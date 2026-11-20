/**
 * Inactive 60-day trial cleanup — policy + email copy (pure, unit-tested).
 *
 *   20 days without signing in → warning email ("sign in within 10 days").
 *   30 days without signing in AND the warning is ≥10 days old → export email with all
 *   their data, then the existing full account deletion (lib/account-purge.ts).
 *   Signing in at any time (or the app refreshing its session) clears the warning.
 *
 * Only owners on a trial with no paid subscription are ever candidates (see
 * trial_inactivity_candidates() in supabase/trial-inactivity-2026-11.sql).
 */

export const TRIAL_INACTIVITY_POLICY = {
  warnAfterDays: 20,
  deleteAfterDays: 30,
  /** Minimum time between the warning email and the deletion, whatever happens. */
  minNoticeDays: 10,
  /** Export download links (signed URLs) stay valid this long. */
  exportLinkDays: 30,
  /** Default trial offers covered: the 60-day launch-promotion trial. */
  defaultOffers: ['2mo'] as readonly string[],
} as const;

const DAY = 24 * 60 * 60 * 1000;

export type InactivityCandidate = {
  user_id: string;
  email: string | null;
  full_name?: string | null;
  signup_offer?: string | null;
  status?: string | null;
  stripe_customer_id?: string | null;
  stripe_subscription_id?: string | null;
  trial_ends_at?: string | null;
  last_active_at: string;
};

export type InactivityCycle = {
  id: string;
  user_id: string;
  last_active_at?: string | null;
  warning_sent_at: string | null;
  export_sent_at: string | null;
  export_prefix?: string | null;
  export_expires_at?: string | null;
  deleted_at: string | null;
  cleared_at: string | null;
  attempts?: number | null;
};

export type InactivityAction =
  | { action: 'none' }
  | { action: 'warn'; inactiveDays: number; deleteAfter: string }
  | { action: 'wait'; inactiveDays: number; deleteAfter: string }
  | { action: 'export_and_delete'; inactiveDays: number }
  | { action: 'delete'; inactiveDays: number }
  | { action: 'clear'; reason: 'signed_in' | 'not_eligible' };

function ms(v: string | null | undefined): number {
  const t = v ? new Date(v).getTime() : NaN;
  return Number.isFinite(t) ? t : NaN;
}

/** When the account may be deleted at the earliest, given the warning time + last activity. */
export function earliestDeletion(lastActiveAt: string, warningSentAt: string, policy = TRIAL_INACTIVITY_POLICY): Date {
  return new Date(
    Math.max(ms(lastActiveAt) + policy.deleteAfterDays * DAY, ms(warningSentAt) + policy.minNoticeDays * DAY)
  );
}

/**
 * Decide what to do for one user. `candidate` is null when the user is no longer an
 * inactive trial owner (signed in, paid, became crew, closed, deleted…).
 */
export function decideInactivityAction(
  candidate: InactivityCandidate | null,
  cycle: InactivityCycle | null,
  now: Date,
  policy = TRIAL_INACTIVITY_POLICY
): InactivityAction {
  const open = cycle && !cycle.cleared_at && !cycle.deleted_at ? cycle : null;
  if (!candidate) return open ? { action: 'clear', reason: 'not_eligible' } : { action: 'none' };

  const lastActive = ms(candidate.last_active_at);
  if (!Number.isFinite(lastActive)) return open ? { action: 'clear', reason: 'not_eligible' } : { action: 'none' };
  const inactiveDays = Math.floor((now.getTime() - lastActive) / DAY);
  // No address → we can never warn them, so we never delete them either.
  const hasEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(candidate.email || '').trim());

  if (open) {
    const warned = ms(open.warning_sent_at);
    // Any activity newer than what we saw when the cycle started ends it (sign-in resets).
    const stored = ms(open.last_active_at ?? null);
    const anchor = Number.isFinite(stored) ? stored : warned;
    if (Number.isFinite(anchor) && lastActive > anchor) return { action: 'clear', reason: 'signed_in' };
    if (!Number.isFinite(warned)) {
      // Row exists but the warning never went out (send failed) → retry the warning.
      if (!hasEmail || inactiveDays < policy.warnAfterDays) return { action: 'none' };
      return {
        action: 'warn',
        inactiveDays,
        deleteAfter: earliestDeletion(candidate.last_active_at, now.toISOString(), policy).toISOString(),
      };
    }
    if (open.export_sent_at) return { action: 'delete', inactiveDays };
    const due = earliestDeletion(candidate.last_active_at, open.warning_sent_at as string, policy);
    if (now.getTime() >= due.getTime() && hasEmail) return { action: 'export_and_delete', inactiveDays };
    return { action: 'wait', inactiveDays, deleteAfter: due.toISOString() };
  }

  if (inactiveDays >= policy.warnAfterDays && hasEmail) {
    return {
      action: 'warn',
      inactiveDays,
      deleteAfter: earliestDeletion(candidate.last_active_at, now.toISOString(), policy).toISOString(),
    };
  }
  return { action: 'none' };
}

/** TRIAL_INACTIVITY_OFFERS="2mo,6mo" → ['2mo','6mo'] (only known offers). */
export function parseOffers(raw: string | undefined | null): string[] {
  const known = new Set(['2mo', '6mo', 'standard']);
  const list = String(raw || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => known.has(s));
  return list.length ? Array.from(new Set(list)) : [...TRIAL_INACTIVITY_POLICY.defaultOffers];
}

/* ------------------------------------------------------------------ emails */

function esc(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function firstName(name: string | null | undefined, _email: string): string {
  const n = String(name || '').trim();
  if (n) return n.split(/\s+/)[0];
  return 'there';
}

export function formatEmailDate(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  return d.toLocaleDateString('en-US', {
    timeZone: 'America/New_York',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

const SUPPORT = 'support@estimateace.com';

function shell(inner: string): string {
  return `<!doctype html><html><body style="margin:0;background:#f4f4f4;padding:24px 12px">
<div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e2e8f0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#0f172a;line-height:1.55">
  <div style="background:#059669;color:#ffffff;padding:18px 24px;font-weight:800;font-size:20px;letter-spacing:-0.01em">EstimateAce</div>
  <div style="padding:24px">${inner}</div>
  <div style="padding:14px 24px;background:#f8fafc;color:#64748b;font-size:12px;border-top:1px solid #e2e8f0">
    EstimateAce · Questions? Reply to this email or write to <a href="mailto:${SUPPORT}" style="color:#047857">${SUPPORT}</a>.
  </div>
</div></body></html>`;
}

function button(href: string, label: string): string {
  return `<p style="margin:22px 0"><a href="${esc(href)}" style="display:inline-block;background:#059669;color:#ffffff;text-decoration:none;padding:13px 20px;border-radius:10px;font-weight:700">${esc(label)}</a></p>`;
}

export function buildWarningEmail(input: {
  name?: string | null;
  email: string;
  lastActiveAt: string;
  deleteAfter: string;
  signInUrl: string;
}) {
  const who = firstName(input.name, input.email);
  const last = formatEmailDate(input.lastActiveAt);
  const deadline = formatEmailDate(input.deleteAfter);
  const subject = `Sign in by ${deadline} to keep your EstimateAce trial account`;
  const text = [
    `Hi ${who},`,
    '',
    `You haven't signed in to EstimateAce since ${last}. Your account is on the 60-day free trial from our launch promotion, and under the promotion terms, trial accounts that go 30 days without signing in are closed and deleted.`,
    '',
    `To keep your account and everything in it, just sign in before ${deadline}:`,
    input.signInUrl,
    '',
    `Signing in once is enough. It resets the clock; there is nothing else to do.`,
    '',
    `If you don't sign in by then, we'll email you a copy of everything you entered (customers, estimates, invoices, jobs, line items and prices, notes, leads, settings, and download links for your photos), and then permanently delete the account. Your trial will be canceled and your card will not be charged.`,
    '',
    `Questions? Reply to this email or contact ${SUPPORT}.`,
    '',
    `— EstimateAce`,
  ].join('\n');
  const html = shell(`
    <p>Hi ${esc(who)},</p>
    <p>You haven't signed in to EstimateAce since <strong>${esc(last)}</strong>. Your account is on the
    <strong>60-day free trial</strong> from our launch promotion, and under the promotion terms, trial
    accounts that go <strong>30 days without signing in</strong> are closed and deleted.</p>
    <p style="font-size:17px"><strong>To keep your account, just sign in before ${esc(deadline)}.</strong></p>
    ${button(input.signInUrl, 'Sign in to keep my account')}
    <p style="font-size:14px;color:#475569">Signing in once is enough. It resets the clock; there is nothing else to do.</p>
    <p style="font-size:14px;color:#475569">If you don't sign in by then, we'll email you a copy of everything you
    entered (customers, estimates, invoices, jobs, line items and prices, notes, leads, settings, and download links
    for your photos), and then permanently delete the account. Your trial will be canceled and your card will not be charged.</p>
    <p style="font-size:13px;color:#64748b">Button not working? Copy this link: <a href="${esc(input.signInUrl)}" style="color:#047857">${esc(input.signInUrl)}</a></p>
  `);
  return { subject, text, html };
}

export function buildExportEmail(input: {
  name?: string | null;
  email: string;
  warningSentAt: string;
  zipUrl: string;
  filesIndexUrl: string | null;
  fileCount: number;
  expiresAt: string;
  zipAttached: boolean;
  newTrialUrl: string;
}) {
  const who = firstName(input.name, input.email);
  const warned = formatEmailDate(input.warningSentAt);
  const expires = formatEmailDate(input.expiresAt);
  const subject = 'Your EstimateAce data export (your trial account is being closed)';
  const files =
    input.fileCount > 0
      ? `Your photos and files (${input.fileCount}): ${input.filesIndexUrl || 'see index.html in the ZIP'}`
      : 'You had no photos or files saved.';
  const text = [
    `Hi ${who},`,
    '',
    `As we let you know on ${warned}, your EstimateAce trial account has gone 30 days without a sign-in, so it is being closed and permanently deleted today. Your trial has been canceled and your card will not be charged.`,
    '',
    `Here is a copy of everything you entered in the app:`,
    '',
    `Your data (ZIP with CSV and JSON files: customers, estimates, invoices, jobs, line items and prices, notes, leads, receipts and settings)${input.zipAttached ? ' is attached to this email, and you can also download it here' : ''}:`,
    input.zipUrl,
    '',
    files,
    '',
    `These download links work until ${expires}. Please save anything you want to keep before then; after that the copies are deleted too.`,
    '',
    `Want to use EstimateAce again? You can start a new account any time: ${input.newTrialUrl}`,
    '',
    `Questions? Reply to this email or contact ${SUPPORT}.`,
    '',
    `— EstimateAce`,
  ].join('\n');
  const html = shell(`
    <p>Hi ${esc(who)},</p>
    <p>As we let you know on <strong>${esc(warned)}</strong>, your EstimateAce trial account has gone 30 days
    without a sign-in, so it is being <strong>closed and permanently deleted today</strong>. Your trial has been
    canceled and your card will not be charged.</p>
    <p><strong>Here is a copy of everything you entered in the app.</strong></p>
    ${button(input.zipUrl, 'Download my data (ZIP)')}
    <p style="font-size:14px;color:#475569">CSV and JSON files: customers, estimates, invoices, jobs, line items and prices,
    notes, leads, receipts and settings.${input.zipAttached ? ' The ZIP is also attached to this email.' : ''}</p>
    ${
      input.fileCount > 0
        ? `<p style="font-size:14px">Your photos and files (${input.fileCount}): ${
            input.filesIndexUrl
              ? `<a href="${esc(input.filesIndexUrl)}" style="color:#047857">open the download list</a>`
              : 'see <code>index.html</code> in the ZIP'
          }.</p>`
        : '<p style="font-size:14px;color:#475569">You had no photos or files saved.</p>'
    }
    <p style="font-size:14px;background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:10px 12px;color:#92400e">
    These download links work until <strong>${esc(expires)}</strong>. Please save anything you want to keep before then;
    after that the copies are deleted too.</p>
    <p style="font-size:14px;color:#475569">Want to use EstimateAce again? You can <a href="${esc(input.newTrialUrl)}" style="color:#047857">start a new account</a> any time.</p>
  `);
  return { subject, text, html };
}

/** Short notice shown with the 60-day launch-promotion trial offer. */
export const TRIAL_INACTIVITY_NOTICE =
  'Launch promotion rule: if you don\u2019t sign in for 20 days during the 60-day trial, we\u2019ll email you a reminder. If you still haven\u2019t signed in 10 days later (30 days total), we\u2019ll email you a copy of all your data and then delete the trial account. Signing in at any time resets the clock. Paid accounts are never affected.';
