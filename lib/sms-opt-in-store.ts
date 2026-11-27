import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { formatPhoneE164 } from '@/lib/notifications';

export type SmsOptInRecord = {
  phone: string;
  optedIn: boolean;
  method: string;
  source?: string;
  ip?: string;
  userAgent?: string;
  pendingConfirm?: boolean;
};

function normalizePhone(phone: string): string | null {
  return formatPhoneE164(phone);
}

/** Upsert consent into sms_opt_ins (best-effort if table missing). */
export async function upsertSmsOptIn(record: SmsOptInRecord): Promise<{ ok: boolean; error?: string }> {
  const phone = normalizePhone(record.phone);
  if (!phone) return { ok: false, error: 'Invalid phone number' };

  const admin = getSupabaseAdmin();
  if (!admin) return { ok: false, error: 'Server missing SUPABASE_SERVICE_ROLE_KEY' };

  const now = new Date().toISOString();
  const row: Record<string, any> = {
    phone,
    opted_in: record.optedIn,
    method: record.method,
    source: record.source || null,
    ip: record.ip || null,
    user_agent: record.userAgent || null,
    updated_at: now,
  };
  if (record.optedIn && !record.pendingConfirm) {
    row.confirmed_at = now;
    row.opted_out_at = null;
  }
  if (!record.optedIn && record.pendingConfirm) {
    // START / web form waiting for YES is a (re-)subscribe, not an opt-out.
    row.opted_out_at = null;
  } else if (!record.optedIn) {
    row.opted_out_at = now;
  }

  const { error } = await admin.from('sms_opt_ins').upsert(row, { onConflict: 'phone' });
  if (error) {
    // Table may not exist yet — log and continue (SMS still sends; run supabase/sms-opt-ins.sql)
    console.warn('sms_opt_ins upsert:', error.message);
    return { ok: true, error: error.message };
  }
  return { ok: true };
}

/**
 * Pending double-opt-in rows (START keyword or web form, waiting for YES) are stored
 * with opted_in=false. They must not be read as STOP: older rows also carry an
 * opted_out_at timestamp, so the method suffix is the reliable signal.
 */
export function consentFromRow(data: {
  opted_in?: boolean | null;
  method?: string | null;
} | null | undefined): { optedIn: boolean; pendingConfirm: boolean; optedOut: boolean } | null {
  if (!data) return null;
  const optedIn = !!data.opted_in;
  const pendingConfirm = !optedIn && /_pending$/.test(String(data.method || ''));
  return { optedIn, pendingConfirm, optedOut: !optedIn && !pendingConfirm };
}

export async function getSmsOptIn(phoneRaw: string): Promise<{
  optedIn: boolean;
  pendingConfirm: boolean;
  /** True only after STOP (or equivalent). Transactional texts are blocked only then. */
  optedOut: boolean;
} | null> {
  const phone = normalizePhone(phoneRaw);
  if (!phone) return null;
  const admin = getSupabaseAdmin();
  if (!admin) return null;

  const { data } = await admin.from('sms_opt_ins').select('*').eq('phone', phone).maybeSingle();
  return consentFromRow(data);
}
