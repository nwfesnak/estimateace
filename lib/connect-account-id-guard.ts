/**
 * Guard for payment_accounts.stripe_account_id.
 *
 * A contractor's Stripe Connect account id must never be silently wiped. On
 * 2026-11-18 a routine status check got "no such account" back from Stripe and
 * nulled the id, leaving no record of which account had been linked. Now:
 *  - a non-null id is only cleared on an explicit deauthorize (the contractor
 *    disconnected EstimateAce in Stripe: account.application.deauthorized);
 *  - every other path keeps the id and just marks the account not ready;
 *  - replacing one id with another (owner tapped Connect Stripe again) is allowed
 *    but always logged with the old id.
 */
export type ConnectIdChangeReason =
  | 'deauthorized'
  | 'onboarding_replace'
  | 'status_sync'
  | 'webhook'
  | 'other';

export type ConnectIdDecision = {
  /** The patch to write (stripe_account_id removed when the change is blocked). */
  patch: Record<string, unknown>;
  /** Whether a change to stripe_account_id is being made, blocked, or left alone. */
  action: 'unchanged' | 'set' | 'replace' | 'clear' | 'blocked_clear';
  previousId: string | null;
  nextId: string | null;
};

function cleanId(v: unknown): string | null {
  const s = typeof v === 'string' ? v.trim() : '';
  return s ? s : null;
}

export function guardStripeAccountIdPatch(
  existingId: string | null | undefined,
  patch: Record<string, unknown>,
  reason: ConnectIdChangeReason = 'other'
): ConnectIdDecision {
  const previousId = cleanId(existingId);
  if (!Object.prototype.hasOwnProperty.call(patch, 'stripe_account_id')) {
    return { patch, action: 'unchanged', previousId, nextId: previousId };
  }
  const nextId = cleanId(patch.stripe_account_id);
  if (nextId === previousId) {
    return { patch, action: 'unchanged', previousId, nextId };
  }
  if (!nextId) {
    if (!previousId) return { patch, action: 'unchanged', previousId, nextId: null };
    if (reason === 'deauthorized') return { patch, action: 'clear', previousId, nextId: null };
    const kept = { ...patch };
    delete kept.stripe_account_id;
    return { patch: kept, action: 'blocked_clear', previousId, nextId: previousId };
  }
  if (!previousId) return { patch, action: 'set', previousId: null, nextId };
  return { patch, action: 'replace', previousId, nextId };
}
