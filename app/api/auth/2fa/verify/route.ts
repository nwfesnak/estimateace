import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/supabase/auth-user';
import {
  create2faSessionToken,
  get2faCookieName,
  loadMfaSettings,
  verifyLoginOtp,
} from '@/lib/login-otp';

export async function POST(request: NextRequest) {
  try {
    const { user, error } = await getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: error || 'Unauthorized' }, { status: 401 });
    }

    const settings = await loadMfaSettings(
      user.id,
      (user.user_metadata?.phone as string) || (user.phone as string) || null
    );

    if (!settings.enabled || !settings.phone) {
      return NextResponse.json({ ok: true, verified: true, required: false });
    }

    const body = await request.json().catch(() => ({}));
    const code = String(body.code || '');

    const result = await verifyLoginOtp(user.id, code);
    if (!result.ok) {
      return NextResponse.json({ error: result.error || 'Invalid code' }, { status: 400 });
    }

    const token = create2faSessionToken(user.id);
    const res = NextResponse.json({ ok: true, verified: true, required: true });
    res.cookies.set(get2faCookieName(), token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 12 * 60 * 60,
    });
    return res;
  } catch (e: any) {
    console.error('2fa verify:', e);
    return NextResponse.json({ error: e?.message || 'Verify failed' }, { status: 500 });
  }
}
