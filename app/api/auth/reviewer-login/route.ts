import { createHash, timingSafeEqual } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { isReviewerDemoEmail } from '@/lib/reviewer-demo';
import { rateLimit, serverError, tooManyRequests } from '@/lib/rate-limit';

/**
 * Password login for the store-reviewer demo account only.
 * Bypasses Cloudflare Turnstile, which often blocks App Review / Play review devices.
 * Everyone else must keep using signInWithPassword + a captcha token.
 */
function passwordsMatch(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

async function passwordAccepted(
  admin: NonNullable<ReturnType<typeof getSupabaseAdmin>>,
  email: string,
  password: string
): Promise<boolean> {
  const expected = String(process.env.REVIEWER_DEMO_PASSWORD || '');
  if (expected && passwordsMatch(password, expected)) return true;

  // Optional DB helper (security definer, service-role only) — see
  // supabase/reviewer-demo-login-2026-11.sql. Lets the account's real
  // Auth password work without a matching Vercel env var.
  try {
    const { data, error } = await admin.rpc('reviewer_demo_password_ok', {
      p_email: email,
      p_password: password,
    });
    if (!error && data === true) return true;
  } catch {
    /* function not installed yet */
  }
  return false;
}

async function issueSession(
  admin: NonNullable<ReturnType<typeof getSupabaseAdmin>>,
  email: string
): Promise<{ access_token: string; refresh_token: string } | { error: string }> {
  const { data, error } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email,
  });
  if (error) return { error: error.message || 'Could not start reviewer session.' };
  const props = data?.properties as
    | { hashed_token?: string; email_otp?: string; action_link?: string }
    | undefined;
  const candidates = [props?.email_otp, props?.hashed_token].filter(
    (t): t is string => !!t
  );
  if (props?.action_link) {
    try {
      const url = new URL(props.action_link);
      const token = url.searchParams.get('token') || url.hash.replace(/^#/, '');
      const tokenHash = url.searchParams.get('token_hash');
      if (token) candidates.push(token);
      if (tokenHash) candidates.push(tokenHash);
    } catch {
      /* ignore */
    }
  }
  for (const token of candidates) {
    for (const type of ['magiclink', 'email'] as const) {
      const { data: sess, error: vErr } = await admin.auth.verifyOtp({
        email,
        token,
        type,
      });
      if (!vErr && sess?.session?.access_token && sess.session.refresh_token) {
        return {
          access_token: sess.session.access_token,
          refresh_token: sess.session.refresh_token,
        };
      }
    }
  }
  return { error: 'Could not issue a reviewer session. Please try again.' };
}

export async function POST(request: NextRequest) {
  try {
    const ip = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
    const limited = await rateLimit(`reviewer-login:${ip}`, 15 * 60, 8);
    if (!limited.allowed) {
      return tooManyRequests(limited, 'Too many login attempts. Please wait and try again.');
    }

    const body = await request.json().catch(() => ({}));
    const email = String(body?.email || '').trim().toLowerCase();
    const password = String(body?.password || '');
    if (!email || !password) {
      return NextResponse.json({ error: 'Enter your email and password.' }, { status: 400 });
    }
    if (!isReviewerDemoEmail(email)) {
      return NextResponse.json({ error: 'Invalid email or password.' }, { status: 401 });
    }

    const admin = getSupabaseAdmin();
    if (!admin) {
      return NextResponse.json({ error: 'Login is temporarily unavailable.' }, { status: 503 });
    }

    const ok = await passwordAccepted(admin, email, password);
    if (!ok) {
      return NextResponse.json({ error: 'Invalid email or password.' }, { status: 401 });
    }

    const session = await issueSession(admin, email);
    if ('error' in session) {
      return NextResponse.json({ error: session.error }, { status: 502 });
    }
    return NextResponse.json(session);
  } catch (e) {
    return serverError('reviewer-login', e, 'Failed to log in. Please try again.');
  }
}
