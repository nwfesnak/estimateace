import { NextRequest, NextResponse } from 'next/server';
import { sendSmsNotification } from '@/lib/notifications';
import { welcomeSms } from '@/lib/sms-compliance';
import { upsertSmsOptIn } from '@/lib/sms-opt-in-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const rateLimitMap = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT = 5;
const WINDOW_MS = 15 * 60 * 1000;

function checkRateLimit(identifier: string) {
  const now = Date.now();
  const entry = rateLimitMap.get(identifier);
  if (!entry || now > entry.resetTime) {
    rateLimitMap.set(identifier, { count: 1, resetTime: now + WINDOW_MS });
    return { allowed: true };
  }
  if (entry.count >= RATE_LIMIT) {
    return { allowed: false };
  }
  entry.count++;
  return { allowed: true };
}

/** Public web form SMS opt-in (double opt-in: welcome, then YES to confirm). */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const phone = String(body.phone || '').trim();
    const name = String(body.name || '').trim();
    const agreed = body.agreed === true;
    const finalConfirm = body.finalConfirm === true;

    const ip =
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      request.headers.get('x-real-ip') ||
      'unknown';
    const userAgent = request.headers.get('user-agent') || '';

    if (!checkRateLimit(`sms-opt-in:${ip}`).allowed) {
      return NextResponse.json(
        { error: 'Too many opt-in attempts. Please wait and try again.' },
        { status: 429 }
      );
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
    return NextResponse.json({ error: e?.message || 'Opt-in failed' }, { status: 500 });
  }
}
