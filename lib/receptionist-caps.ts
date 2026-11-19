/**
 * AI Receptionist cost caps — so nobody has to watch the Twilio bill.
 *
 * Every limit lives in RECEPTIONIST_CAPS. Change a number here and redeploy.
 * Usage is stored per billing period / day in public.receptionist_usage
 * (supabase/receptionist-usage-caps-2026-11.sql). If usage can't be read, the AI does
 * NOT answer (fail closed): the call is forwarded to the contractor or told to call back.
 */
import type { ReceptionistBilling } from '@/lib/receptionist-billing';

export const RECEPTIONIST_CAPS = {
  /** Hard stop for one AI-answered call (the AI wraps up and hangs up). */
  maxCallMinutes: 10,
  /** AI-answered minutes per billing period (Twilio bills whole minutes per call). */
  monthlyAiMinutes: 250,
  /** AI-answered minutes per day (America/New_York), stops a runaway day / call loop. */
  dailyAiMinutes: 30,
  /** Calls from one number to one line per hour; more are rejected as busy (not billed). */
  callsPerCallerPerHour: 5,
  /** Forwarded minutes per billing period (AI off, or after an AI cap). Then "call back". */
  monthlyForwardMinutes: 300,
  /** Longest single forwarded call (<Dial timeLimit>). */
  forwardCallMaxMinutes: 30,
  /** Lead text messages to the owner per billing period (email still goes after this). */
  monthlyLeadSms: 150,
  /** Email the owner once per billing period at these % of the monthly AI minutes. */
  alertPercents: [80, 100] as const,
} as const;

export type ReceptionistCaps = typeof RECEPTIONIST_CAPS;

export const USAGE_TIME_ZONE = 'America/New_York';

/** Whole minutes Twilio bills for a call of `seconds` (rounded up per call leg). */
export function billedSeconds(seconds: number): number {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  return s === 0 ? 0 : Math.ceil(s / 60) * 60;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** YYYY-MM-DD of `now` in the usage time zone (daily cap bucket). */
export function usageDay(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: USAGE_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/**
 * The add-on's current billing period. Monthly subscription: start = period end − 1 month.
 * No usable period end (shouldn't happen while active) → calendar month (UTC).
 */
export function usagePeriod(
  billing: Pick<ReceptionistBilling, 'currentPeriodEnd'> | null | undefined,
  now: Date = new Date()
): { periodStart: string; periodEnd: string; day: string } {
  const end = billing?.currentPeriodEnd ? new Date(billing.currentPeriodEnd) : null;
  if (end && !Number.isNaN(end.getTime()) && end.getTime() > now.getTime()) {
    const start = new Date(end);
    start.setUTCMonth(start.getUTCMonth() - 1);
    if (start.getTime() <= now.getTime()) {
      return { periodStart: isoDate(start), periodEnd: end.toISOString(), day: usageDay(now) };
    }
  }
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { periodStart: isoDate(start), periodEnd: next.toISOString(), day: usageDay(now) };
}

export type ReceptionistUsage = {
  monthAiSeconds: number;
  dayAiSeconds: number;
  monthForwardSeconds: number;
  monthSms: number;
};

export type InboundDecision =
  | { action: 'reject'; reason: 'caller_rate_limit' }
  | { action: 'ai'; maxCallSeconds: number }
  | { action: 'forward'; reason: CapReason }
  | { action: 'call_back'; reason: CapReason | 'forward_cap' };

export type CapReason = 'usage_unavailable' | 'session_unavailable' | 'monthly_ai_cap' | 'daily_ai_cap' | 'ai_off';

/**
 * What to do with an inbound call to an AI-on line. Pure; caps injectable for tests.
 * `usage` null = couldn't read usage → never run the AI (fail closed).
 */
export function decideInboundCall(input: {
  usage: ReceptionistUsage | null;
  callerAllowed: boolean;
  hasForwardNumber: boolean;
  caps?: ReceptionistCaps;
}): InboundDecision {
  const caps = input.caps || RECEPTIONIST_CAPS;
  if (!input.callerAllowed) return { action: 'reject', reason: 'caller_rate_limit' };

  let reason: CapReason | null = null;
  let maxCallSeconds = caps.maxCallMinutes * 60;
  if (!input.usage) {
    reason = 'usage_unavailable';
  } else {
    const monthLeft = caps.monthlyAiMinutes * 60 - input.usage.monthAiSeconds;
    const dayLeft = caps.dailyAiMinutes * 60 - input.usage.dayAiSeconds;
    if (monthLeft < 60) reason = 'monthly_ai_cap';
    else if (dayLeft < 60) reason = 'daily_ai_cap';
    else maxCallSeconds = Math.min(maxCallSeconds, monthLeft, dayLeft);
  }
  if (!reason) return { action: 'ai', maxCallSeconds };
  return forwardOrCallBack(reason, input.usage, input.hasForwardNumber, caps);
}

/** Forward (bounded) or play the call-back message. Also used when the AI is turned off. */
export function forwardOrCallBack(
  reason: CapReason,
  usage: ReceptionistUsage | null,
  hasForwardNumber: boolean,
  caps: ReceptionistCaps = RECEPTIONIST_CAPS
): Extract<InboundDecision, { action: 'forward' | 'call_back' }> {
  if (!hasForwardNumber) return { action: 'call_back', reason };
  // Forwarding also costs Twilio minutes (cheap, and each forward is capped by
  // <Dial timeLimit> + the per-caller limit). Over the monthly forward cap → call back.
  if (usage && usage.monthForwardSeconds >= caps.monthlyForwardMinutes * 60) {
    return { action: 'call_back', reason: 'forward_cap' };
  }
  return { action: 'forward', reason };
}

/** True once an AI call has used its time (checked on every turn). */
export function callTimeUp(
  session: { createdAt?: string; maxCallSeconds?: number },
  now: number = Date.now(),
  caps: ReceptionistCaps = RECEPTIONIST_CAPS
): boolean {
  const started = Date.parse(String(session.createdAt || ''));
  if (!Number.isFinite(started)) return false;
  const limit = Math.min(
    caps.maxCallMinutes * 60,
    Number(session.maxCallSeconds) > 0 ? Number(session.maxCallSeconds) : caps.maxCallMinutes * 60
  );
  return now - started >= limit * 1000;
}

/** Alert levels newly crossed by the monthly AI minutes (each sent once per period). */
export function alertLevelsReached(monthAiSeconds: number, caps: ReceptionistCaps = RECEPTIONIST_CAPS): number[] {
  const pct = (monthAiSeconds / (caps.monthlyAiMinutes * 60)) * 100;
  return caps.alertPercents.filter((p) => pct >= p);
}

export function callerBucket(userId: string, from: string): string {
  const digits = String(from || '').replace(/\D/g, '').slice(-10) || 'unknown';
  return `recv:caller:${userId}:${digits}`;
}

/** Messages the caller hears. Short on purpose (TTS is billed per character). */
export const CAP_MESSAGES = {
  forward: (business: string) => `Thanks for calling ${business}. Connecting you now.`,
  callBack: (business: string) =>
    `Thanks for calling ${business}. We can't take your call right now. Please call back later. Goodbye.`,
  timeUp: (business: string) =>
    `Thanks for calling ${business}. We have your details and will get back to you as soon as possible. Goodbye.`,
};
