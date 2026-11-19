import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { getStripe } from '@/lib/stripe-server';
import {
  deleteAllUserMedia,
  deleteOwnerCrewLogins,
  releaseAccountPhoneLine,
  stopAccountBilling,
} from '@/lib/account-cleanup';

/**
 * Hard-delete user data + auth after account_closes_at.
 *
 * Order matters: stop every charge first (main plan, crew seats, AI Receptionist
 * add-on, Twilio number). If any charge cannot be stopped the purge stops and the
 * daily cron retries, so we never delete an account that is still being billed.
 */
export async function purgeClosedAccount(userId: string): Promise<{ ok: boolean; error?: string }> {
  const admin = getSupabaseAdmin();
  if (!admin) return { ok: false, error: 'No admin client' };

  try {
    const stripe = getStripe();
    if (stripe) {
      await stopAccountBilling(admin, stripe, userId, 'now');
    } else {
      const { data: subRow } = await admin
        .from('subscriptions')
        .select('stripe_subscription_id')
        .eq('user_id', userId)
        .maybeSingle();
      if (subRow?.stripe_subscription_id) {
        return { ok: false, error: 'Stripe not configured; cannot confirm billing stopped' };
      }
    }

    try {
      await releaseAccountPhoneLine(userId);
    } catch (e) {
      return { ok: false, error: `Twilio release failed: ${(e as Error)?.message || e}` };
    }

    const media = await deleteAllUserMedia(admin, userId);
    if (!media.complete) {
      // Very large account: the rest is removed on the next cron run.
      return { ok: false, error: `media purge partial (${media.removed} removed); will continue next run` };
    }

    await deleteOwnerCrewLogins(admin, userId);

    await admin.from('archive-est').delete().eq('user_id', userId);
    await admin.from('estimates').delete().eq('user_id', userId);
    await admin.from('subscriptions').delete().eq('user_id', userId);

    // Remaining per-user rows (crew_members, crew seats, payment_accounts, receipts,
    // receptionist tables, login codes, promo redemptions) cascade from auth.users.
    const { error } = await admin.auth.admin.deleteUser(userId);
    if (error) {
      console.error('auth deleteUser:', error);
      return { ok: false, error: error.message };
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || 'purge failed' };
  }
}

/**
 * If subscriptions.account_closes_at is past, purge and return true.
 * The close date is read ONLY from the server-only subscriptions row (users and crew
 * can only SELECT it). It is never read from the user-editable SETTINGS row.
 */
export async function purgeIfAccountClosed(userId: string): Promise<boolean> {
  const admin = getSupabaseAdmin();
  if (!admin) return false;

  const { data: row, error } = await admin
    .from('subscriptions')
    .select('account_closes_at')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) {
    console.warn('purgeIfAccountClosed:', error.message);
    return false;
  }

  const closesAt = (row as { account_closes_at?: string | null } | null)?.account_closes_at;
  if (!closesAt) return false;
  const t = new Date(closesAt).getTime();
  if (isNaN(t) || t > Date.now()) return false;

  await purgeClosedAccount(userId);
  return true;
}

/**
 * Daily cron: purge every account whose scheduled close date has passed, even if the
 * user never logs in again. Bounded per run; the rest are picked up the next day.
 */
export async function purgeDueAccounts(limit = 25): Promise<{
  checked: number;
  purged: number;
  failed: number;
  error?: string;
}> {
  const admin = getSupabaseAdmin();
  if (!admin) return { checked: 0, purged: 0, failed: 0, error: 'No admin client' };

  const { data, error } = await admin
    .from('subscriptions')
    .select('user_id, account_closes_at')
    .not('account_closes_at', 'is', null)
    .lte('account_closes_at', new Date().toISOString())
    .order('account_closes_at', { ascending: true })
    .limit(limit);
  if (error) return { checked: 0, purged: 0, failed: 0, error: error.message };

  let purged = 0;
  let failed = 0;
  for (const row of (data || []) as { user_id: string }[]) {
    const result = await purgeClosedAccount(row.user_id);
    if (result.ok) purged++;
    else {
      failed++;
      console.error('account purge failed for', String(row.user_id).slice(0, 8), result.error);
    }
  }
  return { checked: (data || []).length, purged, failed };
}
