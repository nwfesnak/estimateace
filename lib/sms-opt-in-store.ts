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
  if (!record.optedIn) {
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

export async function getSmsOptIn(phoneRaw: string): Promise<{
  optedIn: boolean;
  pendingConfirm?: boolean;
} | null> {
  const phone = normalizePhone(phoneRaw);
  if (!phone) return null;
  const admin = getSupabaseAdmin();
  if (!admin) return null;

  const { data } = await admin.from('sms_opt_ins').select('*').eq('phone', phone).maybeSingle();
  if (data) {
    return { optedIn: !!data.opted_in };
  }
  return null;
}
