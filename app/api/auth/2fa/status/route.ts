import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/supabase/auth-user';
import {
  get2faCookieName,
  loadMfaSettings,
  verify2faSessionToken,
  maskPhone,
} from '@/lib/login-otp';

export async function GET(request: NextRequest) {
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
        verified: true,
        enabled: false,
        phoneMasked: null,
        twilioConfigured: !!(
          process.env.TWILIO_ACCOUNT_SID &&
          process.env.TWILIO_AUTH_TOKEN &&
          process.env.TWILIO_PHONE_NUMBER
        ),
      });
    }

    const cookie = request.cookies.get(get2faCookieName())?.value;
    const verified = verify2faSessionToken(cookie, user.id);

    return NextResponse.json({
      required: true,
      verified,
      enabled: true,
      phoneMasked: maskPhone(settings.phone),
      twilioConfigured: !!(
        process.env.TWILIO_ACCOUNT_SID &&
        process.env.TWILIO_AUTH_TOKEN &&
        process.env.TWILIO_PHONE_NUMBER
      ),
    });
  } catch (e: any) {
    console.error('2fa status:', e);
    return NextResponse.json({ error: e?.message || 'Status failed' }, { status: 500 });
  }
}
