/**
 * Guard for user-triggered outbound email/SMS (documents, reminders, recurring plans…).
 *  - requires a confirmed email address (works whether Supabase email confirmation
 *    is on or off: with it off, Supabase stamps email_confirmed_at at signup), and
 *  - reserves per-workspace daily quotas in the shared rate limiter.
 */
import { NextResponse } from 'next/server';
import { reserveSendQuota } from '@/lib/rate-limit';

type UserLike = {
  id: string;
  email_confirmed_at?: string | null;
  confirmed_at?: string | null;
  app_metadata?: Record<string, unknown> | null;
};

export function isEmailConfirmed(user: UserLike | null | undefined): boolean {
  if (!user) return false;
  // Crew logins are created by the owner with email_confirm: true.
  return Boolean(user.email_confirmed_at || user.confirmed_at);
}

export const EMAIL_NOT_CONFIRMED_MESSAGE =
  'Please confirm your email address first (check your inbox for the confirmation link), then try again.';

export async function guardUserSends(
  user: UserLike,
  workspaceUserId: string,
  counts: { sms?: number; email?: number }
): Promise<NextResponse | null> {
  if (!isEmailConfirmed(user)) {
    return NextResponse.json(
      { error: EMAIL_NOT_CONFIRMED_MESSAGE, code: 'email_not_confirmed' },
      { status: 403 }
    );
  }
  const sms = Math.max(0, counts.sms || 0);
  const email = Math.max(0, counts.email || 0);
  if (sms > 0) {
    const denied = await reserveSendQuota(workspaceUserId || user.id, 'sms', sms);
    if (denied) return denied;
  }
  if (email > 0) {
    const denied = await reserveSendQuota(workspaceUserId || user.id, 'email', email);
    if (denied) return denied;
  }
  return null;
}
