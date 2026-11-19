/**
 * Stripe Connect webhook guard: an event that changes an owner's records (marks an
 * invoice paid, activates / updates a recurring plan) must come from THAT owner's
 * connected account. Metadata such as supabase_user_id / invoice_id is written by
 * whoever creates the Checkout Session — on a Standard connected account the
 * contractor can create sessions with their own keys — so metadata alone is not proof.
 */
import { getPaymentAccount } from '@/lib/job-payments';

/** True only when both ids are present and identical (acct_...). */
export function connectAccountMatches(
  eventAccount: string | null | undefined,
  savedAccountId: string | null | undefined
): boolean {
  const a = String(eventAccount || '').trim();
  const b = String(savedAccountId || '').trim();
  if (!a || !b) return false;
  if (!/^acct_[A-Za-z0-9]+$/.test(a)) return false;
  return a === b;
}

export type ConnectOwnerCheck =
  | { ok: true }
  | { ok: false; reason: 'missing_event_account' | 'missing_owner' | 'no_saved_account' | 'account_mismatch' };

/** Does `eventAccount` equal the owner's saved payment_accounts.stripe_account_id? */
export async function verifyConnectEventOwner(
  eventAccount: string | null | undefined,
  ownerUserId: string | null | undefined,
  loadSaved: (userId: string) => Promise<{ stripe_account_id: string | null } | null> = getPaymentAccount
): Promise<ConnectOwnerCheck> {
  if (!String(eventAccount || '').trim()) return { ok: false, reason: 'missing_event_account' };
  const owner = String(ownerUserId || '').trim();
  if (!owner) return { ok: false, reason: 'missing_owner' };
  const saved = await loadSaved(owner);
  if (!saved?.stripe_account_id) return { ok: false, reason: 'no_saved_account' };
  return connectAccountMatches(eventAccount, saved.stripe_account_id)
    ? { ok: true }
    : { ok: false, reason: 'account_mismatch' };
}
