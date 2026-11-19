import { NextRequest, NextResponse } from 'next/server';
import { formatPhoneE164, sendSmsNotification } from '@/lib/notifications';
import { clientIp, isUsPhoneE164, rateLimit, tooManyRequests } from '@/lib/rate-limit';
import { welcomeSms } from '@/lib/sms-compliance';
import { upsertSmsOptIn } from '@/lib/sms-opt-in-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DAY = 24 * 60 * 60;

/** Only our own pages may post this form (blocks drive-by cross-site posts). */
function originAllowed(request: NextRequest): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return true; // same-origin fetches from some browsers omit Origin
  try {
    const host = new URL(origin).host.toLowerCase();
    const self = request.nextUrl.host.toLowerCase();
    return (
      host === self ||
      host === 'app.estimateace.com' ||
      host === 'estimateace.com' ||
      host === 'www.estimateace.com' ||
      host.startsWith('localhost:') ||
      host.startsWith('127.0.0.1:')
    );
  } catch {
    return false;
  }
}

/** Public web form SMS opt-in (double opt-in: welcome, then YES to confirm). */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const phone = String(body.phone || '').trim();
    const name = String(body.name || '').trim();
    const agreed = body.agreed === true;
    const finalConfirm = body.finalConfirm === true;

    const ip = clientIp(request);
    const userAgent = request.headers.get('user-agent') || '';

    if (!originAllowed(request)) {
      return NextResponse.json({ error: 'Origin not allowed' }, { status: 403 });
    }
    // Honeypot: real users never fill the hidden "website" field.
    if (String(body.website || '').trim()) {
      return NextResponse.json({ ok: true, optedIn: false, pendingConfirm: true });
    }

    const perIp = await rateLimit(`sms-opt-in:ip:${ip}`, 60 * 60, 5);
    if (!perIp.allowed) {
      return tooManyRequests(perIp, 'Too many opt-in attempts. Please wait and try again.');
    }

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
    const e164 = formatPhoneE164(phone);
    if (!e164 || !isUsPhoneE164(e164)) {
      return NextResponse.json(
        { error: 'Enter a valid US mobile number.' },
        { status: 400 }
      );
    }
    const perPhone = await rateLimit(`sms-opt-in:phone:${e164}`, DAY, 3);
    if (!perPhone.allowed) {
      return tooManyRequests(perPhone, 'A confirmation text was already sent to this number. Check your phone.');
    }
    const global = await rateLimit('sms-opt-in:global', DAY, 200);
    if (!global.allowed) {
      return tooManyRequests(global, 'Opt-in is temporarily busy. Please try again later.');
    }

    // Do NOT mark opted-in until they reply YES to the SMS (double opt-in)
    await upsertSmsOptIn({
      phone,
      optedIn: false,
      method: 'web_form_pending',
      source: name || 'web',
      ip,
      userAgent,
      pendingConfirm: true,
    });

    const text = welcomeSms('EstimateAce');
    const sms = await sendSmsNotification(phone, text, {
      waitForStatus: true,
      skipOptInCheck: true,
    });

    if (!sms.ok) {
      return NextResponse.json({
        ok: false,
        error:
          sms.error ||
          'Could not send confirmation SMS. Check Twilio A2P / number registration.',
        optedIn: false,
      });
    }

    return NextResponse.json({
      ok: true,
      optedIn: false,
      pendingConfirm: true,
      message:
        'Check your phone and reply YES to finish opting in. Reply STOP anytime to opt out.',
      smsStatus: sms.status,
    });
  } catch (e: any) {
    console.error('sms opt-in:', e);
    return NextResponse.json({ error: 'Opt-in failed' }, { status: 500 });
  }
}
