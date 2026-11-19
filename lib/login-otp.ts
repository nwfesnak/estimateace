import { createHash, createHmac, randomInt, timingSafeEqual } from 'crypto';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { formatPhoneE164, sendSmsNotification } from '@/lib/notifications';
import { rateLimit } from '@/lib/rate-limit';

function isDeployed(): boolean {
  return process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL);
}

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

/**
 * Platform switch for SMS two-step sign-in (soft launch: off until the Twilio line is
 * active). Set SMS_2FA_ENABLED=true on Vercel to turn the feature on.
 */
export function isSms2faAvailable(): boolean {
  return (process.env.SMS_2FA_ENABLED || '').trim().toLowerCase() === 'true';
}

type MetaCarrier = { app_metadata?: Record<string, unknown> | null } | null | undefined;

/**
 * The on/off switch and phone live in the user's auth app_metadata, which ONLY the
 * server (service role) can write. They are never read from the user-editable
 * SETTINGS row, so a stolen session cannot quietly turn two-step off.
 */
export function mfaSettingsFromUser(user: MetaCarrier): MfaSettings {
  if (!isSms2faAvailable()) return { enabled: false, phone: null };
  const raw = (user?.app_metadata?.sms_2fa || null) as { enabled?: unknown; phone?: unknown } | null;
  const phone = raw?.phone ? formatPhoneE164(String(raw.phone)) : null;
  if (raw?.enabled !== true || !phone) return { enabled: false, phone };
  return { enabled: true, phone };
}

/** Load 2FA settings for a user id (server-only app_metadata). */
export async function loadMfaSettings(userId: string, _metaPhone?: string | null): Promise<MfaSettings> {
  void _metaPhone;
  if (!isSms2faAvailable()) return { enabled: false, phone: null };
  const admin = getSupabaseAdmin();
  if (!admin) return { enabled: false, phone: null };
  const { data } = await admin.auth.admin.getUserById(userId);
  return mfaSettingsFromUser(data?.user as MetaCarrier);
}

/** Server-only write of the 2FA switch (service role → auth app_metadata). */
export async function saveMfaSettings(
  userId: string,
  next: { enabled: boolean; phone: string | null; pendingPhone?: string | null }
): Promise<{ ok: boolean; error?: string }> {
  const admin = getSupabaseAdmin();
  if (!admin) return { ok: false, error: 'Server missing SUPABASE_SERVICE_ROLE_KEY.' };
  const { data } = await admin.auth.admin.getUserById(userId);
  const meta = { ...((data?.user?.app_metadata || {}) as Record<string, unknown>) };
  meta.sms_2fa = {
    enabled: next.enabled,
    phone: next.phone,
    updated_at: new Date().toISOString(),
  };
  if (next.pendingPhone === undefined) {
    /* keep */
  } else if (next.pendingPhone) meta.sms_2fa_pending = { phone: next.pendingPhone, at: new Date().toISOString() };
  else delete meta.sms_2fa_pending;
  const { error } = await admin.auth.admin.updateUserById(userId, { app_metadata: meta });
  return error ? { ok: false, error: error.message } : { ok: true };
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
    // Never fall back to per-instance memory in production: codes would randomly fail
    // across serverless instances. Run supabase/security-hardening-2026-11.sql.
    if (isDeployed()) throw new Error(`login_otp unavailable: ${error.message}`);
    console.warn('login_otp upsert failed (dev memory store):', error.message);
  } else if (isDeployed()) {
    throw new Error('Server missing SUPABASE_SERVICE_ROLE_KEY for login codes.');
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

  // Shared limit across resends so "Resend code" can't be used to keep guessing.
  const verifyLimit = await rateLimit(`2fa-verify:${userId}`, 60 * 60, 15);
  if (!verifyLimit.allowed) {
    return { ok: false, error: 'Too many attempts. Wait an hour and try again.' };
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
    if (isDeployed()) {
      return { ok: false, error: error ? 'Could not check the code. Try again.' : 'No code found. Tap Resend code.' };
    }
  } else if (isDeployed()) {
    return { ok: false, error: 'Could not check the code. Try again.' };
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
  const sendLimit = await rateLimit(`2fa-send:${userId}`, 60 * 60, 5);
  if (!sendLimit.allowed) {
    return { ok: false, error: 'Too many codes requested. Wait a bit and try again.' };
  }
  const code = String(randomInt(100000, 1000000));
  try {
    await storeLoginOtp(userId, code);
  } catch (e: unknown) {
    console.error('login otp store:', e instanceof Error ? e.message : e);
    return { ok: false, error: 'Could not create a login code. Try again shortly.' };
  }
  const body = `EstimateAce login code: ${code}. Valid 10 minutes. If you did not try to sign in, ignore this message.`;
  const sms = await sendSmsNotification(phone, body, { skipOptInCheck: true });
  if (!sms.ok) {
    return { ok: false, error: sms.error || 'Could not send SMS.' };
  }
  return { ok: true, phoneMasked: maskPhone(phone) };
}
