/**
 * Read / record AI Receptionist usage (public.receptionist_usage). Server only.
 * Pure cap rules live in lib/receptionist-caps.ts.
 */
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { loadReceptionistBilling } from '@/lib/receptionist-billing';
import {
  alertLevelsReached,
  billedSeconds,
  RECEPTIONIST_CAPS,
  usagePeriod,
  type ReceptionistUsage,
} from '@/lib/receptionist-caps';

type Admin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;

export async function currentUsagePeriod(userId: string, now: Date = new Date()) {
  return usagePeriod(await loadReceptionistBilling(userId).catch(() => null), now);
}

/** Current month + day usage, or null if it can't be read (callers fail closed). */
export async function loadReceptionistUsage(
  userId: string,
  period?: { periodStart: string; day: string },
  admin: Admin | null = getSupabaseAdmin()
): Promise<ReceptionistUsage | null> {
  if (!admin || !userId) return null;
  try {
    const p = period || (await currentUsagePeriod(userId));
    const { data, error } = await admin
      .from('receptionist_usage')
      .select('period_kind, period_start, ai_seconds, forward_seconds, sms_count')
      .eq('user_id', userId)
      .in('period_start', [p.periodStart, p.day]);
    if (error) {
      console.warn('receptionist usage read:', error.message);
      return null;
    }
    const rows = (data || []) as Array<{
      period_kind: string;
      period_start: string;
      ai_seconds: number;
      forward_seconds: number;
      sms_count: number;
    }>;
    const month = rows.find((r) => r.period_kind === 'month' && r.period_start === p.periodStart);
    const day = rows.find((r) => r.period_kind === 'day' && r.period_start === p.day);
    return {
      monthAiSeconds: Number(month?.ai_seconds) || 0,
      dayAiSeconds: Number(day?.ai_seconds) || 0,
      monthForwardSeconds: Number(month?.forward_seconds) || 0,
      monthSms: Number(month?.sms_count) || 0,
    };
  } catch (e) {
    console.warn('receptionist usage read:', e);
    return null;
  }
}

/** Record one finished call once (Twilio status callback). Returns month AI seconds after. */
export async function recordReceptionistCall(input: {
  callSid: string;
  userId: string;
  kind: 'ai' | 'forward';
  durationSeconds: number;
  admin?: Admin | null;
}): Promise<{ recorded: boolean; monthAiSeconds: number; periodStart: string } | null> {
  const admin = input.admin === undefined ? getSupabaseAdmin() : input.admin;
  if (!admin || !input.callSid || !input.userId) return null;
  const p = await currentUsagePeriod(input.userId);
  const { data, error } = await admin.rpc('receptionist_usage_record_call', {
    p_call_sid: input.callSid.slice(0, 64),
    p_user_id: input.userId,
    p_kind: input.kind,
    p_seconds: billedSeconds(input.durationSeconds),
    p_period_start: p.periodStart,
    p_day: p.day,
  });
  if (error) {
    console.error('receptionist usage record:', error.message);
    return null;
  }
  const row = (Array.isArray(data) ? data[0] : data) as
    | { recorded?: boolean; month_ai_seconds?: number }
    | undefined;
  return {
    recorded: Boolean(row?.recorded),
    monthAiSeconds: Number(row?.month_ai_seconds) || 0,
    periodStart: p.periodStart,
  };
}

/** Reserve one lead text for this period. false = over the cap or unknown (skip the SMS). */
export async function takeLeadSms(userId: string, admin: Admin | null = getSupabaseAdmin()): Promise<boolean> {
  if (!admin || !userId) return false;
  try {
    const p = await currentUsagePeriod(userId);
    const { data, error } = await admin.rpc('receptionist_usage_take_sms', {
      p_user_id: userId,
      p_period_start: p.periodStart,
      p_max: RECEPTIONIST_CAPS.monthlyLeadSms,
    });
    if (error) {
      console.warn('receptionist sms cap:', error.message);
      return false;
    }
    const row = (Array.isArray(data) ? data[0] : data) as { allowed?: boolean } | undefined;
    return row?.allowed === true;
  } catch (e) {
    console.warn('receptionist sms cap:', e);
    return false;
  }
}

/**
 * After a call is recorded: email the owner once per period at 80% and at 100% of the
 * monthly AI minutes (existing email path; best effort, never blocks the webhook).
 */
export async function maybeSendUsageAlerts(input: {
  userId: string;
  periodStart: string;
  monthAiSeconds: number;
  admin?: Admin | null;
  send?: (to: string, subject: string, text: string, company: string) => Promise<unknown>;
}): Promise<number[]> {
  const admin = input.admin === undefined ? getSupabaseAdmin() : input.admin;
  if (!admin) return [];
  const levels = alertLevelsReached(input.monthAiSeconds);
  if (!levels.length) return [];

  const { data: settings } = await admin
    .from('estimates')
    .select('profile')
    .eq('id', `SETTINGS-${input.userId}`)
    .maybeSingle();
  const profile = (settings?.profile || {}) as {
    email?: string;
    company?: string;
    aiReceptionist?: { notifyEmail?: string };
  };
  const to = String(profile.aiReceptionist?.notifyEmail || profile.email || '').trim();
  if (!to.includes('@')) return [];
  const company = String(profile.company || 'EstimateAce');

  const sent: number[] = [];
  // Highest level only if both crossed at once (one email, not two).
  for (const level of [...levels].sort((a, b) => b - a)) {
    const { data: claimed, error } = await admin.rpc('receptionist_usage_claim_alert', {
      p_user_id: input.userId,
      p_period_start: input.periodStart,
      p_level: level,
    });
    if (error || claimed !== true) continue;
    if (sent.length) continue; // lower level claimed silently when a higher one was just sent
    const used = Math.round(input.monthAiSeconds / 60);
    const cap = RECEPTIONIST_CAPS.monthlyAiMinutes;
    const subject =
      level >= 100
        ? 'AI Receptionist: monthly minutes used up'
        : `AI Receptionist: ${level}% of monthly minutes used`;
    const text =
      level >= 100
        ? `Your AI Receptionist has used ${used} of ${cap} AI minutes this billing period.\n\nUntil your plan renews, calls to your AI line are forwarded to your transfer number (or callers are asked to call back if none is set). Nothing else to do — usage resets automatically.`
        : `Your AI Receptionist has used ${used} of ${cap} AI minutes this billing period (${level}%).\n\nWhen the minutes run out, calls are forwarded to your transfer number until your plan renews. You can see usage in AI Receptionist → Phone line.`;
    try {
      if (input.send) await input.send(to, subject, text, company);
      else {
        const { sendEmailNotification } = await import('@/lib/notifications');
        await sendEmailNotification(to, subject, text, { companyName: 'EstimateAce' });
      }
      sent.push(level);
    } catch (e) {
      console.warn('receptionist usage alert email:', e);
    }
  }
  return sent;
}
