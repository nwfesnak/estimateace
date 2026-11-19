import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { getStripe } from '@/lib/stripe-server';
import {
  deleteAllUserMedia,
  deleteOwnerCrewLogins,
  releaseAccountPhoneLine,
  stopAccountBilling,
} from '@/lib/account-cleanup';
import { crewSeatReleaseDeps, releaseSeatsForDeletedCrew } from '@/lib/crew-seat-release';

/**
 * Every public table that holds a user's data, and the column that ties a row to them.
 * Order matters: rows other steps still read (crew_members for crew logins,
 * receptionist_accounts for the Twilio line, crew_seat_subscriptions for billing) are
 * removed only after those steps ran. `subscriptions` is deliberately NOT here: it
 * holds account_closes_at, which is what makes the daily cron retry a purge that
 * failed half-way, so it goes last (cascade from the auth user).
 *
 * All of these also cascade from auth.users (ON DELETE CASCADE, checked against the
 * live schema), so deleting them explicitly is belt-and-braces: a future table
 * without a cascade still gets cleaned, and a failure stops before the auth user goes.
 */
export const ACCOUNT_DATA_TABLES: ReadonlyArray<{ table: string; column: string; what: string }> = [
  { table: 'estimates', column: 'user_id', what: 'estimates, invoices, jobs, customers, settings/profile, receptionist settings, call sessions, messages and email summaries' },
  { table: 'archive-est', column: 'user_id', what: 'archived estimates and invoices' },
  { table: 'receipts', column: 'user_id', what: 'receipt records' },
  { table: 'payment_accounts', column: 'user_id', what: 'link to their Stripe Connect payout account' },
  { table: 'receptionist_blocked_numbers', column: 'user_id', what: 'AI Receptionist blocked callers' },
  { table: 'receptionist_call_finalizations', column: 'user_id', what: 'AI Receptionist call log' },
  { table: 'receptionist_accounts', column: 'user_id', what: 'AI Receptionist line + add-on billing' },
  { table: 'crew_seat_subscriptions', column: 'owner_user_id', what: 'crew seats they paid for' },
  { table: 'crew_members', column: 'owner_user_id', what: 'their crew (access to this workspace)' },
  { table: 'crew_members', column: 'crew_user_id', what: 'their own crew membership in someone else\'s workspace' },
  { table: 'login_otp', column: 'user_id', what: 'login codes' },
  { table: 'promo_redemptions', column: 'user_id', what: 'promo claims' },
];

/**
 * Tables intentionally NOT purged per user, with the reason (kept in sync with the
 * live schema by scripts/test-account-deletion.test.mjs).
 */
export const ACCOUNT_DATA_KEPT: Readonly<Record<string, string>> = {
  subscriptions: 'deleted last, by cascade from the auth user (keeps the cron retry working until then)',
  stripe_disputes: 'payment dispute record required for accounting; owner_user_id is set to NULL (no personal data)',
  sms_opt_ins: 'SMS consent proof keyed by phone number only (carrier / TCPA compliance), not linked to an account',
  rate_limit_counters: 'short-lived counters; any key containing the user id is deleted by the purge',
  promo_limits: 'global promo settings, no user data',
};

type DeleteResult = PromiseLike<{ error: { message?: string } | null; count?: number | null }>;
type PurgeAdmin = {
  from: (table: string) => {
    delete: (opts?: { count?: 'exact' }) => {
      eq: (column: string, value: string) => DeleteResult;
      like: (column: string, pattern: string) => DeleteResult;
    };
  };
  auth: { admin: { deleteUser: (id: string) => Promise<{ error: { message?: string; status?: number } | null }> } };
};

export type PurgeSteps = {
  stopBilling: (userId: string) => Promise<void>;
  /** If this user is someone's crew member: end the seat the owner pays for. */
  releaseCrewSeats: (userId: string) => Promise<unknown>;
  releasePhoneLine: (userId: string) => Promise<unknown>;
  deleteMedia: (userId: string) => Promise<{ removed: number; complete: boolean }>;
  deleteCrewLogins: (userId: string) => Promise<number>;
};

export type PurgeResult = {
  ok: boolean;
  error?: string;
  /** Rows removed per table (explicit deletes; cascades are not counted). */
  removed?: Record<string, number>;
  mediaRemoved?: number;
  crewLoginsDeleted?: number;
};

function isUserMissing(error: { message?: string; status?: number } | null): boolean {
  return !!error && (error.status === 404 || /not.?found/i.test(error.message || ''));
}

/**
 * Permanently delete an account. Safe to run again after a partial failure: every
 * step is idempotent, and the auth user (and with it the subscriptions row the cron
 * uses to retry) is removed only after everything else succeeded.
 */
export async function purgeAccountData(
  admin: PurgeAdmin,
  userId: string,
  steps: PurgeSteps
): Promise<PurgeResult> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) {
    return { ok: false, error: 'Refusing to purge: not a user id' };
  }
  const removed: Record<string, number> = {};
  try {
    // 1. Stop every charge (main plan, crew seats, AI Receptionist add-on). Throws if
    //    anything is still billing, so nothing is deleted while they're being charged.
    //    Stripe customers / invoices are kept for tax and accounting.
    await steps.stopBilling(userId);

    // 1b. They were a crew member on someone else's account: cancel that owner's seat
    //     for them (same as the owner deleting the crew member). Throws → retry later.
    await steps.releaseCrewSeats(userId);

    // 2. Release the Twilio number and close the subaccount.
    try {
      await steps.releasePhoneLine(userId);
    } catch (e) {
      return { ok: false, error: `Twilio release failed: ${(e as Error)?.message || e}` };
    }

    // 3. Files: everything under media/<userId>/ (crew uploads live there too).
    const media = await steps.deleteMedia(userId);
    if (!media.complete) {
      return {
        ok: false,
        mediaRemoved: media.removed,
        error: `media purge partial (${media.removed} removed); will continue next run`,
      };
    }

    // 4. Crew logins this owner created (seat access ends with the workspace).
    const crewLoginsDeleted = await steps.deleteCrewLogins(userId);

    // 5. Every per-user table.
    for (const { table, column } of ACCOUNT_DATA_TABLES) {
      const { error, count } = await admin.from(table).delete({ count: 'exact' }).eq(column, userId);
      if (error) {
        return { ok: false, removed, error: `delete ${table}.${column}: ${error.message || error}` };
      }
      removed[`${table}.${column}`] = count || 0;
    }

    // 6. Rate-limit / AI-quota counters keyed by this user id.
    {
      const { error, count } = await admin
        .from('rate_limit_counters')
        .delete({ count: 'exact' })
        .like('bucket', `%${userId.toLowerCase()}%`);
      if (error) return { ok: false, removed, error: `delete rate_limit_counters: ${error.message || error}` };
      removed['rate_limit_counters.bucket'] = count || 0;
    }

    // 7. The login itself. Cascades the subscriptions row (and anything left over).
    const { error } = await admin.auth.admin.deleteUser(userId);
    if (error && !isUserMissing(error)) {
      console.error('auth deleteUser:', error);
      return { ok: false, removed, error: error.message || 'auth delete failed' };
    }
    if (isUserMissing(error)) {
      // Already gone (re-run): make sure no schedule row is left behind.
      await admin.from('subscriptions').delete().eq('user_id', userId);
    }
    return { ok: true, removed, mediaRemoved: media.removed, crewLoginsDeleted };
  } catch (e) {
    return { ok: false, removed, error: (e as Error)?.message || 'purge failed' };
  }
}

/**
 * Hard-delete user data + auth after account_closes_at.
 *
 * Order matters: stop every charge first (main plan, crew seats, AI Receptionist
 * add-on, Twilio number). If any charge cannot be stopped the purge stops and the
 * daily cron retries, so we never delete an account that is still being billed.
 */
export async function purgeClosedAccount(userId: string): Promise<PurgeResult> {
  const admin = getSupabaseAdmin();
  if (!admin) return { ok: false, error: 'No admin client' };
  const stripe = getStripe();
  return purgeAccountData(admin as unknown as PurgeAdmin, userId, {
    stopBilling: async (uid) => {
      if (stripe) {
        await stopAccountBilling(admin, stripe, uid, 'now');
        return;
      }
      const { data: subRow } = await admin
        .from('subscriptions')
        .select('stripe_subscription_id')
        .eq('user_id', uid)
        .maybeSingle();
      if (subRow?.stripe_subscription_id) {
        throw new Error('Stripe not configured; cannot confirm billing stopped');
      }
    },
    releaseCrewSeats: async (uid) => {
      const deps = crewSeatReleaseDeps(admin);
      if (stripe) return releaseSeatsForDeletedCrew(stripe, uid, deps);
      const seats = [...(await deps.memberships(uid)), ...(await deps.seatsByCrewUser(uid))];
      if (seats.some((s) => s.stripe_subscription_id)) {
        throw new Error('Stripe not configured; cannot end the crew seat this user occupies');
      }
    },
    releasePhoneLine: (uid) => releaseAccountPhoneLine(uid),
    deleteMedia: (uid) => deleteAllUserMedia(admin, uid),
    deleteCrewLogins: (uid) => deleteOwnerCrewLogins(admin, uid),
  });
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
