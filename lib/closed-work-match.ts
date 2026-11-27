/**
 * "Tight job match" used to hide estimate twins of closed (paid / archived) work.
 *
 * The Estimates list hides an active estimate when a paid or archived document has the same
 * job name + zip (or job name + address). That catches leftover work-order twins, but it also
 * hid brand-new estimates for repeat clients: a new "Lease Evaluations Inc" estimate vanished
 * from the list because a paid invoice for the same client and zip was archived months ago.
 *
 * Rule: a job match only counts when the estimate was created no later than the closed work.
 * An estimate created after every matching closure is new work and stays visible. When either
 * time is unknown (legacy rows), the old behavior (hide) is kept.
 *
 * Self-contained on purpose (no imports) so it can be unit tested in isolation.
 */

export type ClosedJobKeys = Map<string, number | null>;

function toMs(raw: unknown): number | null {
  if (raw == null || raw === '') return null;
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw.getTime();
  const s = String(raw).trim();
  if (!s) return null;
  // Date-only (YYYY-MM-DD): local midnight, never UTC (avoids an off-by-one-day shift).
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return Number.isNaN(d.getTime()) ? null : d.getTime();
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

/** When the closed work was closed out: archived_at for archive rows, else last update. */
export function closedWorkAtMs(row: any): number | null {
  return toMs(row?.archived_at) ?? toMs(row?.updated_at);
}

/**
 * When an estimate was created. New documents stamp profile._jobSettingsSnapshottedAt at
 * creation; older rows fall back to the document date (start of that local day).
 */
export function estimateCreatedAtMs(row: any): number | null {
  const profile = row?.profile && typeof row.profile === 'object' ? row.profile : null;
  return toMs(profile?._jobSettingsSnapshottedAt) ?? toMs(row?.date);
}

/** Record a closed job key, keeping the latest closure time (unknown time wins: legacy hide). */
export function addClosedJobKey(keys: ClosedJobKeys, key: string, closedAt: number | null): void {
  if (!keys.has(key)) {
    keys.set(key, closedAt);
    return;
  }
  const prev = keys.get(key) ?? null;
  if (prev === null || closedAt === null) keys.set(key, null);
  else keys.set(key, Math.max(prev, closedAt));
}

/**
 * True when one of the estimate's tight job keys (jobzip: / jobaddr:) matches closed work
 * that was closed at or after the estimate was created.
 */
export function tightJobMatchClosesEstimate(
  est: any,
  estJobKeys: string[],
  closedJobKeys: ClosedJobKeys
): boolean {
  const created = estimateCreatedAtMs(est);
  for (const k of estJobKeys) {
    if (!(k.startsWith('jobzip:') || k.startsWith('jobaddr:'))) continue;
    if (!closedJobKeys.has(k)) continue;
    const closedAt = closedJobKeys.get(k) ?? null;
    if (created === null || closedAt === null) return true;
    if (created <= closedAt) return true;
  }
  return false;
}
