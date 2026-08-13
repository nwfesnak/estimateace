import { createHash, createHmac, randomInt, timingSafeEqual } from 'crypto';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { formatPhoneE164, sendSmsNotification } from '@/lib/notifications';

const OTP_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // skip re-SMS for 12h after verify
const MAX_ATTEMPTS = 5;
const COOKIE_NAME = 'ea_2fa_ok';

type MemoryOtp = {
  codeHash: string;
  expiresAt: number;
  attempts: number;
};

const g = globalThis as typeof globalThis & { __estimateaceLoginOtp?: Map<string, MemoryOtp> };
function memoryStore() {
  if (!g.__estimateaceLoginOtp) g.__estimateaceLoginOtp = new Map();
  return g.__estimateaceLoginOtp;
}

function pepper(): string {
  return (
    process.env.OTP_PEPPER ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.TWILIO_AUTH_TOKEN ||
    'estimateace-otp-dev'
  );
}

export function hashOtp(userId: string, code: string): string {
  return createHash('sha256').update(`${userId}:${code}:${pepper()}`).digest('hex');
}

export function maskPhone(phone: string): string {
  const e164 = formatPhoneE164(phone) || phone.replace(/\D/g, '');
  if (e164.length < 4) return '***';
  return `${e164.slice(0, -4).replace(/\d/g, '•')}${e164.slice(-4)}`;
}

export function get2faCookieName() {
  return COOKIE_NAME;
}

export function create2faSessionToken(userId: string): string {
  const exp = Date.now() + SESSION_TTL_MS;
  const payload = `${userId}.${exp}`;
  const sig = createHmac('sha256', pepper()).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

export function verify2faSessionToken(token: string | undefined | null, userId: string): boolean {
  if (!token || !userId) return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [uid, expStr, sig] = parts;
  if (uid !== userId) return false;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || Date.now() > exp) return false;
  const payload = `${uid}.${expStr}`;
  const expected = createHmac('sha256', pepper()).update(payload).digest('hex');
  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export type MfaSettings = {
  enabled: boolean;
  phone: string | null;
};

/** Load 2FA settings from SETTINGS profile + auth metadata */
export async function loadMfaSettings(userId: string, metaPhone?: string | null): Promise<MfaSettings> {
  // Soft launch: SMS two-step is disabled until phone / Twilio line is active.
  // Re-enable by restoring the SETTINGS profile check below.
  void userId;
  void metaPhone;
  return { enabled: false, phone: null };

  /*
  const admin = getSupabaseAdmin();
  let enabled = false;
  let phone: string | null = null;

  if (admin) {
    const { data } = await admin
      .from('estimates')
      .select('profile')
      .eq('id', `SETTINGS-${userId}`)
      .maybeSingle();
    const p = (data?.profile || {}) as Record<string, any>;
    enabled = p.twoFactorEnabled === true || p.mfaSmsEnabled === true;
    phone =
      String(p.twoFactorPhone || p.mfaPhone || p.phone || '').trim() || null;
  }

  if (!phone && metaPhone) {
    phone = String(metaPhone).trim() || null;
  }

  const normalized = phone ? formatPhoneE164(phone) : null;
  // Only require 2FA when explicitly enabled AND we have a valid phone
  if (!enabled || !normalized) {
    return { enabled: false, phone: normalized };
  }
  return { enabled: true, phone: normalized };
  */
}

export async function storeLoginOtp(userId: string, code: string): Promise<void> {
  const codeHash = hashOtp(userId, code);
  const expiresAt = new Date(Date.now() + OTP_TTL_MS).toISOString();
  const admin = getSupabaseAdmin();

  if (admin) {
    const { error } = await admin.from('login_otp').upsert(
      {
        user_id: userId,
        code_hash: codeHash,
        expires_at: expiresAt,
        attempts: 0,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' }
    );
    if (!error) return;
    // Table may not exist yet — fall through to memory
    console.warn('login_otp upsert failed (using memory store):', error.message);
  }

  memoryStore().set(userId, {
    codeHash,
    expiresAt: Date.now() + OTP_TTL_MS,
    attempts: 0,
  });
}

export async function verifyLoginOtp(
  userId: string,
  code: string
): Promise<{ ok: boolean; error?: string }> {
  const clean = String(code || '').replace(/\D/g, '').slice(0, 6);
  if (clean.length !== 6) {
    return { ok: false, error: 'Enter the 6-digit code from your text message.' };
  }

  const admin = getSupabaseAdmin();
  if (admin) {
    const { data, error } = await admin
      .from('login_otp')
      .select('code_hash, expires_at, attempts')
      .eq('user_id', userId)
      .maybeSingle();

    if (!error && data) {
      if (new Date(data.expires_at).getTime() < Date.now()) {
        return { ok: false, error: 'Code expired. Tap Resend code for a new one.' };
      }
      const attempts = Number(data.attempts) || 0;
      if (attempts >= MAX_ATTEMPTS) {
        return { ok: false, error: 'Too many attempts. Tap Resend code for a new one.' };
      }
      const expected = hashOtp(userId, clean);
      const match =
        data.code_hash.length === expected.length &&
        timingSafeEqual(Buffer.from(data.code_hash), Buffer.from(expected));
      if (!match) {
        await admin
          .from('login_otp')
          .update({ attempts: attempts + 1, updated_at: new Date().toISOString() })
          .eq('user_id', userId);
        return { ok: false, error: 'Incorrect code. Check the text and try again.' };
      }
      await admin.from('login_otp').delete().eq('user_id', userId);
      return { ok: true };
    }
  }

  const mem = memoryStore().get(userId);
  if (!mem) {
    return { ok: false, error: 'No code found. Tap Resend code.' };
  }
  if (mem.expiresAt < Date.now()) {
    memoryStore().delete(userId);
    return { ok: false, error: 'Code expired. Tap Resend code for a new one.' };
  }
  if (mem.attempts >= MAX_ATTEMPTS) {
    return { ok: false, error: 'Too many attempts. Tap Resend code for a new one.' };
  }
  const expected = hashOtp(userId, clean);
  const match =
    mem.codeHash.length === expected.length &&
    timingSafeEqual(Buffer.from(mem.codeHash), Buffer.from(expected));
  if (!match) {
    mem.attempts += 1;
    memoryStore().set(userId, mem);
    return { ok: false, error: 'Incorrect code. Check the text and try again.' };
  }
  memoryStore().delete(userId);
  return { ok: true };
}

export async function sendLoginOtpSms(userId: string, phone: string): Promise<{ ok: boolean; error?: string; phoneMasked?: string }> {
  const code = String(randomInt(100000, 999999));
  await storeLoginOtp(userId, code);
  const body = `EstimateAce login code: ${code}. Valid 10 minutes. If you did not try to sign in, ignore this message.`;
  const sms = await sendSmsNotification(phone, body);
  if (!sms.ok) {
    return { ok: false, error: sms.error || 'Could not send SMS.' };
  }
  return { ok: true, phoneMasked: maskPhone(phone) };
}
