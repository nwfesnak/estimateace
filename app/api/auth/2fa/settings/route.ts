import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/supabase/auth-user';
import { formatPhoneE164 } from '@/lib/notifications';
import {
  create2faSessionToken,
  get2faCookieName,
  isSms2faAvailable,
  maskPhone,
  mfaSettingsFromUser,
  saveMfaSettings,
  sendLoginOtpSms,
  verify2faSessionToken,
  verifyLoginOtp,
} from '@/lib/login-otp';

/**
 * The ONLY way to turn SMS two-step sign-in on or off (stored in server-only auth
 * app_metadata; the browser cannot write it).
 *
 * POST { action: 'start', phone }  → texts a code to the phone being enrolled
 * POST { action: 'confirm', code } → turns two-step on for that phone
 * POST { action: 'disable' }       → turns it off (needs a verified device first)
 *
 * Changing the phone or turning two-step off while it is on requires this device to
 * have passed two-step already (the ea_2fa_ok cookie).
 */
export async function POST(request: NextRequest) {
  try {
    const { user, error } = await getUserFromRequest(request, { allowPendingTwoStep: true });
    if (!user) return NextResponse.json({ error: error || 'Unauthorized' }, { status: 401 });
    if (!isSms2faAvailable()) {
      return NextResponse.json(
        { error: 'SMS two-step verification is not available yet.', code: 'sms_2fa_unavailable' },
        { status: 409 }
      );
    }

    const current = mfaSettingsFromUser(user);
    const deviceVerified = verify2faSessionToken(request.cookies.get(get2faCookieName())?.value, user.id);
    if (current.enabled && !deviceVerified) {
      return NextResponse.json(
        { error: 'Verify the code on this device before changing two-step settings.', code: 'two_step_required' },
        { status: 401 }
      );
    }

    const body = await request.json().catch(() => ({}));
    const action = String(body.action || '');

    if (action === 'start') {
      const phone = formatPhoneE164(String(body.phone || ''));
      if (!phone) return NextResponse.json({ error: 'Enter a valid mobile number.' }, { status: 400 });
      const saved = await saveMfaSettings(user.id, {
        enabled: current.enabled,
        phone: current.phone,
        pendingPhone: phone,
      });
      if (!saved.ok) return NextResponse.json({ error: 'Could not start setup. Try again.' }, { status: 503 });
      const sent = await sendLoginOtpSms(user.id, phone);
      if (!sent.ok) return NextResponse.json({ error: sent.error || 'Could not send text.' }, { status: 503 });
      return NextResponse.json({ ok: true, sent: true, phoneMasked: maskPhone(phone) });
    }

    if (action === 'confirm') {
      const pending = (user.app_metadata?.sms_2fa_pending || null) as { phone?: string; at?: string } | null;
      const pendingPhone = pending?.phone ? formatPhoneE164(pending.phone) : null;
      const startedAt = pending?.at ? Date.parse(pending.at) : 0;
      if (!pendingPhone || !startedAt || Date.now() - startedAt > 15 * 60 * 1000) {
        return NextResponse.json({ error: 'Start setup again to get a new code.' }, { status: 400 });
      }
      const result = await verifyLoginOtp(user.id, String(body.code || ''));
      if (!result.ok) return NextResponse.json({ error: result.error || 'Invalid code' }, { status: 400 });
      const saved = await saveMfaSettings(user.id, { enabled: true, phone: pendingPhone, pendingPhone: null });
      if (!saved.ok) return NextResponse.json({ error: 'Could not save. Try again.' }, { status: 503 });
      const res = NextResponse.json({ ok: true, enabled: true, phoneMasked: maskPhone(pendingPhone) });
      res.cookies.set(get2faCookieName(), create2faSessionToken(user.id), {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge: 12 * 60 * 60,
      });
      return res;
    }

    if (action === 'disable') {
      const saved = await saveMfaSettings(user.id, { enabled: false, phone: current.phone, pendingPhone: null });
      if (!saved.ok) return NextResponse.json({ error: 'Could not save. Try again.' }, { status: 503 });
      return NextResponse.json({ ok: true, enabled: false });
    }

    return NextResponse.json({ error: 'Unknown action.' }, { status: 400 });
  } catch (e) {
    console.error('2fa settings:', e);
    return NextResponse.json({ error: 'Request failed' }, { status: 500 });
  }
}
