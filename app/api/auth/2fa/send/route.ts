import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/supabase/auth-user';
import {
  get2faCookieName,
  loadMfaSettings,
  sendLoginOtpSms,
  verify2faSessionToken,
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
      return NextResponse.json({
        required: false,
        sent: false,
        message: 'SMS 2-step verification is not enabled for this account.',
      });
    }

    const cookie = request.cookies.get(get2faCookieName())?.value;
    if (verify2faSessionToken(cookie, user.id)) {
      return NextResponse.json({
        required: true,
        verified: true,
        sent: false,
        phoneMasked: null,
        message: 'Already verified on this device for a while.',
      });
    }

    const result = await sendLoginOtpSms(user.id, settings.phone);
    if (!result.ok) {
      return NextResponse.json(
        {
          error:
            result.error ||
            'Could not send text. Check Twilio env vars on the server (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER).',
        },
        { status: 503 }
      );
    }

    return NextResponse.json({
      required: true,
      verified: false,
      sent: true,
      phoneMasked: result.phoneMasked,
      message: 'Verification code sent by text message.',
    });
  } catch (e: any) {
    console.error('2fa send:', e);
    return NextResponse.json({ error: e?.message || 'Send failed' }, { status: 500 });
  }
}
