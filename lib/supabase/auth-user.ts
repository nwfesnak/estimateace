import { createClient } from '@supabase/supabase-js';
import type { NextRequest } from 'next/server';
import { get2faCookieName, mfaSettingsFromUser, verify2faSessionToken } from '@/lib/login-otp';

export const TWO_STEP_REQUIRED = 'Two-step verification required. Enter the code we texted you.';

/**
 * Server-side SMS two-step gate. When the account has two-step turned on (server-only
 * app_metadata, see lib/login-otp.ts), API calls need the httpOnly device cookie set by
 * /api/auth/2fa/verify. Returns true when the request must be refused.
 *
 * Limit (Supabase Free plan): this protects EstimateAce's own API routes. Direct
 * database (PostgREST) calls with a valid session token are not gated; full
 * enforcement needs Supabase Auth MFA (AAL2) and RLS on aal claims.
 */
export function twoStepPending(
  request: Pick<NextRequest, 'cookies'>,
  user: { id: string; app_metadata?: Record<string, unknown> | null }
): boolean {
  const mfa = mfaSettingsFromUser(user);
  if (!mfa.enabled) return false;
  const cookie = request.cookies?.get(get2faCookieName())?.value;
  return !verify2faSessionToken(cookie, user.id);
}

export async function getUserFromRequest(
  request: NextRequest,
  opts: { allowPendingTwoStep?: boolean } = {}
) {
  const authHeader = request.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return { user: null as null, error: 'Missing Authorization bearer token' };
  }
  const token = authHeader.slice(7);
  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').trim();
  const anon = (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '').trim();
  if (!url || !anon) {
    return { user: null as null, error: 'Supabase not configured' };
  }
  const supabase = createClient(url, anon, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  if (error || !user) {
    return { user: null as null, error: 'Unauthorized' };
  }
  if (!opts.allowPendingTwoStep && twoStepPending(request, user)) {
    return { user: null as null, error: TWO_STEP_REQUIRED };
  }
  return { user, error: null as null };
}
