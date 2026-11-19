/**
 * Server-only AI Receptionist storage (table public.receptionist_accounts).
 *
 * Holds what must never be user-editable or user-readable:
 *   - the add-on entitlement (mirror of the Stripe subscription), and
 *   - the Twilio line (number / SIDs) + the subaccount auth token.
 *
 * The table has RLS on, no policies and no grants to anon/authenticated, so only the
 * service role can touch it (see supabase/security-hardening-2026-11.sql).
 * The SETTINGS-<uid> row in `estimates` keeps a display copy for the UI, but the server
 * never trusts it for billing, routing or secrets.
 */
import { getSupabaseAdmin } from '@/lib/supabase/admin';

export type ReceptionistBillingRecord = {
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  status?: string | null;
  currentPeriodEnd?: string | null;
  cancelAtPeriodEnd?: boolean;
};

export type ReceptionistLine = {
  phoneNumber: string;
  subaccountSid: string;
  numberSid: string;
};

export type ReceptionistPrivate = {
  userId: string;
  billing: ReceptionistBillingRecord;
  line: ReceptionistLine | null;
  subaccountAuthToken: string;
};

const TABLE = 'receptionist_accounts';

/** Digits-only key used to compare phone numbers (E.164 +1XXXXXXXXXX → 1XXXXXXXXXX). */
export function phoneDigits(phone: string | null | undefined): string {
  const d = String(phone || '').replace(/\D/g, '');
  if (d.length === 10) return `1${d}`;
  return d;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped Supabase row
function rowToPrivate(row: any): ReceptionistPrivate {
  const phone = String(row?.phone_number || '').trim();
  return {
    userId: String(row?.user_id || ''),
    billing:
      row?.billing && typeof row.billing === 'object' && !Array.isArray(row.billing)
        ? (row.billing as ReceptionistBillingRecord)
        : {},
    line: phone
      ? {
          phoneNumber: phone,
          subaccountSid: String(row?.subaccount_sid || '').trim(),
          numberSid: String(row?.number_sid || '').trim(),
        }
      : null,
    subaccountAuthToken: String(row?.subaccount_auth_token || '').trim(),
  };
}

export async function loadReceptionistPrivate(userId: string): Promise<ReceptionistPrivate | null> {
  const admin = getSupabaseAdmin();
  if (!admin || !userId) return null;
  const { data, error } = await admin.from(TABLE).select('*').eq('user_id', userId).maybeSingle();
  if (error) {
    console.error('receptionist_accounts read failed (migration applied?):', error.message);
    return null;
  }
  return data ? rowToPrivate(data) : null;
}

async function upsertPrivate(userId: string, patch: Record<string, unknown>): Promise<void> {
  const admin = getSupabaseAdmin();
  if (!admin) throw new Error('Server missing SUPABASE_SERVICE_ROLE_KEY.');
  const { error } = await admin
    .from(TABLE)
    .upsert({ user_id: userId, ...patch, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
  if (error) throw new Error(`receptionist_accounts write failed: ${error.message}`);
}

/** Server-only: record the add-on billing state (from Stripe webhook / sync only). */
export async function saveReceptionistBillingPrivate(
  userId: string,
  billing: ReceptionistBillingRecord
): Promise<void> {
  await upsertPrivate(userId, { billing });
}

/**
 * Server-only: set (or clear with null) the provisioned Twilio line. Only the
 * enable/disable routes call this, after provisioning/releasing in Twilio.
 * Passing `subaccountAuthToken` replaces the stored token; omitting it keeps it.
 */
export async function saveReceptionistLinePrivate(
  userId: string,
  line: ReceptionistLine | null,
  subaccountAuthToken?: string | null
): Promise<void> {
  const patch: Record<string, unknown> = {
    phone_number: line?.phoneNumber ? line.phoneNumber.trim() : null,
    subaccount_sid: line?.subaccountSid || null,
    number_sid: line?.numberSid || null,
  };
  if (subaccountAuthToken !== undefined) {
    patch.subaccount_auth_token = subaccountAuthToken ? subaccountAuthToken.trim() : null;
  }
  await upsertPrivate(userId, patch);
}

/** Resolve the contractor that owns a Twilio number (E.164). Used by webhooks. */
export async function findReceptionistUserIdByPhone(toNumber: string): Promise<string | null> {
  const admin = getSupabaseAdmin();
  if (!admin) return null;
  const want = String(toNumber || '').replace(/\s/g, '');
  if (!want) return null;

  const exact = await admin.from(TABLE).select('user_id').eq('phone_number', want).limit(1);
  if (exact.error) {
    console.error('receptionist_accounts lookup failed (migration applied?):', exact.error.message);
    return null;
  }
  if (exact.data?.[0]?.user_id) return String(exact.data[0].user_id);

  // Stored numbers are E.164; tolerate a formatting difference on the incoming side.
  const digits = phoneDigits(want);
  if (!digits) return null;
  const alt = `+${digits}`;
  if (alt === want) return null;
  const second = await admin.from(TABLE).select('user_id').eq('phone_number', alt).limit(1);
  return second.data?.[0]?.user_id ? String(second.data[0].user_id) : null;
}
