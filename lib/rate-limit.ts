/**
 * Shared, persistent rate limiting backed by Postgres (public.rate_limit_hit, see
 * supabase/security-hardening-2026-11.sql). Works across all Vercel instances,
 * unlike in-memory Maps that reset on every cold start.
 *
 * If the database function is unavailable (migration not applied yet / outage) we fall
 * back to a per-instance in-memory counter so limits never silently disappear.
 */
import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';

export type RateLimitResult = { allowed: boolean; used: number; resetAt: number };

const g = globalThis as typeof globalThis & {
  __eaRateLimitMem?: Map<string, { count: number; resetAt: number }>;
};
function mem() {
  if (!g.__eaRateLimitMem) g.__eaRateLimitMem = new Map();
  return g.__eaRateLimitMem;
}

function memoryHit(bucket: string, windowSec: number, max: number, cost: number): RateLimitResult {
  const now = Date.now();
  const store = mem();
  const entry = store.get(bucket);
  if (!entry || now > entry.resetAt) {
    const fresh = { count: cost, resetAt: now + windowSec * 1000 };
    store.set(bucket, fresh);
    return { allowed: cost <= max, used: cost, resetAt: fresh.resetAt };
  }
  entry.count += cost;
  return { allowed: entry.count <= max, used: entry.count, resetAt: entry.resetAt };
}

/**
 * Count `cost` hits against `bucket` in a fixed window of `windowSec` seconds.
 * Returns allowed=false once the window total exceeds `max`.
 */
export async function rateLimit(
  bucket: string,
  windowSec: number,
  max: number,
  cost = 1
): Promise<RateLimitResult> {
  const key = bucket.slice(0, 200);
  const admin = getSupabaseAdmin();
  if (admin) {
    try {
      const { data, error } = await admin.rpc('rate_limit_hit', {
        p_bucket: key,
        p_window_seconds: windowSec,
        p_max: max,
        p_cost: cost,
      });
      const row = Array.isArray(data) ? data[0] : data;
      if (!error && row && typeof row.allowed === 'boolean') {
        return {
          allowed: row.allowed,
          used: Number(row.used) || 0,
          resetAt: row.reset_at ? Date.parse(row.reset_at) : Date.now() + windowSec * 1000,
        };
      }
      if (error) console.warn('rate_limit_hit unavailable, using memory fallback:', error.message);
    } catch (e) {
      console.warn('rate_limit_hit failed, using memory fallback:', e);
    }
  }
  return memoryHit(key, windowSec, max, cost);
}

/** Standard 429 response for a failed limit. */
export function tooManyRequests(result: RateLimitResult, message: string): NextResponse {
  const retryAfter = Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000));
  return NextResponse.json(
    { error: message, retryAfterSeconds: retryAfter },
    { status: 429, headers: { 'Retry-After': String(retryAfter) } }
  );
}

/** Best-effort client IP from Vercel / proxy headers. */
export function clientIp(request: Request): string {
  const h = request.headers;
  return (
    h.get('x-real-ip') ||
    (h.get('x-forwarded-for') || '').split(',')[0].trim() ||
    h.get('cf-connecting-ip') ||
    'unknown'
  );
}

const DAY = 24 * 60 * 60;

function envInt(name: string, fallback: number): number {
  const n = Number.parseInt(String(process.env[name] || ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Per-workspace daily caps for outbound messages (override with env vars). */
export const SEND_LIMITS = {
  smsPerAccountPerDay: () => envInt('SMS_DAILY_LIMIT_PER_ACCOUNT', 100),
  emailPerAccountPerDay: () => envInt('EMAIL_DAILY_LIMIT_PER_ACCOUNT', 300),
  smsGlobalPerDay: () => envInt('SMS_DAILY_LIMIT_GLOBAL', 2000),
};

/**
 * Reserve `count` outbound sends of `kind` for a workspace today.
 * Returns a 429 response when over the cap, or null when allowed.
 */
export async function reserveSendQuota(
  workspaceUserId: string,
  kind: 'sms' | 'email',
  count: number
): Promise<NextResponse | null> {
  if (!workspaceUserId || count <= 0) return null;
  const max =
    kind === 'sms' ? SEND_LIMITS.smsPerAccountPerDay() : SEND_LIMITS.emailPerAccountPerDay();
  const result = await rateLimit(`send:${kind}:${workspaceUserId}`, DAY, max, count);
  if (result.allowed) return null;
  return tooManyRequests(
    result,
    kind === 'sms'
      ? `Daily text limit reached (${max} per day). Try again tomorrow or contact support to raise it.`
      : `Daily email limit reached (${max} per day). Try again tomorrow or contact support to raise it.`
  );
}

// NANP area codes that are NOT in the United States (Canada + Caribbean/Atlantic).
// Caribbean +1 numbers are a common SMS-pumping target, so they are refused.
export const CANADA_AREA_CODES = new Set(
  (
    '204 226 236 249 250 257 263 289 306 343 354 365 367 368 382 387 403 416 418 428 431 437 ' +
    '438 450 460 468 474 506 514 519 548 579 581 584 587 600 604 613 622 639 647 672 683 705 ' +
    '709 742 753 778 780 782 807 819 825 867 873 879 902 905 942'
  ).split(/\s+/)
);

/** +1 numbers outside the US and Canada (Caribbean / Atlantic): billed as international. */
export const CARIBBEAN_NANP_AREA_CODES = new Set(
  '242 246 264 268 284 345 441 473 649 658 664 721 758 767 784 809 829 849 868 869 876'.split(/\s+/)
);

const NON_US_NANP_AREA_CODES = new Set([...CANADA_AREA_CODES, ...CARIBBEAN_NANP_AREA_CODES]);

/** True for a valid United States number in E.164 (+1NXXNXXXXXX, US area code). */
export function isUsPhoneE164(e164: string | null | undefined): boolean {
  const m = String(e164 || '').match(/^\+1([2-9]\d{2})[2-9]\d{6}$/);
  if (!m) return false;
  return !NON_US_NANP_AREA_CODES.has(m[1]);
}

/** Per-workspace daily caps for paid AI calls (override with env vars). */
export const AI_LIMITS = {
  /** Text / vision AI calls (quotes, chat suggestions, translate, receipt scan, website facts). */
  callsPerAccountPerDay: () => envInt('AI_DAILY_LIMIT_PER_ACCOUNT', 300),
  /** UI / document translation batches. */
  translationsPerAccountPerDay: () => envInt('AI_TRANSLATE_DAILY_LIMIT_PER_ACCOUNT', 500),
  /** AI image renders (most expensive). */
  rendersPerAccountPerDay: () => envInt('AI_RENDER_DAILY_LIMIT_PER_ACCOUNT', 30),
  /** Inbound email leads summarized per workspace per day. */
  inboundEmailsPerAccountPerDay: () => envInt('INBOUND_EMAIL_DAILY_LIMIT_PER_ACCOUNT', 50),
};

/**
 * Reserve one paid AI call of `kind` for a workspace today (crew share the owner's
 * quota — pass the workspace owner id). Returns a 429 response when over the cap.
 */
export async function reserveAiQuota(
  workspaceUserId: string,
  kind: 'ai' | 'render' | 'translate',
  cost = 1
): Promise<NextResponse | null> {
  if (!workspaceUserId) return null;
  const max =
    kind === 'render'
      ? AI_LIMITS.rendersPerAccountPerDay()
      : kind === 'translate'
        ? AI_LIMITS.translationsPerAccountPerDay()
        : AI_LIMITS.callsPerAccountPerDay();
  const result = await rateLimit(`ai:${kind}:${workspaceUserId}`, DAY, max, cost);
  if (result.allowed) return null;
  return tooManyRequests(
    result,
    kind === 'render'
      ? `Daily AI image limit reached (${max} per day). Try again tomorrow or contact support to raise it.`
      : kind === 'translate'
        ? `Daily translation limit reached (${max} per day). Try again tomorrow.`
        : `Daily AI limit reached (${max} requests per day). Try again tomorrow or contact support to raise it.`
  );
}

/** Generic 500 body: log the real error server-side, never return internals to the client. */
export function serverError(label: string, e: unknown, message = 'Something went wrong. Please try again.'): NextResponse {
  console.error(`${label}:`, e instanceof Error ? e.message : e);
  return NextResponse.json({ error: message }, { status: 500 });
}
