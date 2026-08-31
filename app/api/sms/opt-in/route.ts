import { NextRequest, NextResponse } from 'next/server';
import { sendSmsNotification } from '@/lib/notifications';
import { confirmationSms, welcomeSms } from '@/lib/sms-compliance';
import { upsertSmsOptIn } from '@/lib/sms-opt-in-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Public web form SMS opt-in (double opt-in: welcome then confirmation text). */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const phone = String(body.phone || '').trim();
    const name = String(body.name || '').trim();
    const agreed = body.agreed === true;
    const finalConfirm = body.finalConfirm === true;

    if (!agreed) {
      return NextResponse.json(
        { error: 'You must agree to receive text messages to continue.' },
        { status: 400 }
      );
    }
    if (!finalConfirm) {
      return NextResponse.json(
        { error: 'Please confirm you want to receive texts (final confirmation).' },
        { status: 400 }
      );
    }
    if (!phone) {
      return NextResponse.json({ error: 'Mobile phone number is required.' }, { status: 400 });
    }

    const ip =
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      request.headers.get('x-real-ip') ||
      '';
    const userAgent = request.headers.get('user-agent') || '';

    await upsertSmsOptIn({
      phone,
      optedIn: true,
      method: 'web_form',
      source: name || 'web',
      ip,
      userAgent,
      pendingConfirm: false,
    });

    const text = confirmationSms('EstimateAce');
    const sms = await sendSmsNotification(phone, text, { waitForStatus: true });

    // Also send welcome-style first message content if confirm failed silently — prefer one clear confirm
    if (!sms.ok) {
      // Still try welcome as fallback notice
      await sendSmsNotification(phone, welcomeSms('EstimateAce'));
      return NextResponse.json({
        ok: false,
        error:
          sms.error ||
          'Opt-in saved, but confirmation SMS failed. Check Twilio A2P / toll-free verification.',
        optedIn: true,
      });
    }

    return NextResponse.json({
      ok: true,
      optedIn: true,
      message:
        'You are opted in. A confirmation text was sent to your phone. Reply STOP anytime to opt out.',
      smsStatus: sms.status,
    });
  } catch (e: any) {
    console.error('sms opt-in:', e);
    return NextResponse.json({ error: e?.message || 'Opt-in failed' }, { status: 500 });
  }
}
