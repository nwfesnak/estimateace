import { NextRequest, NextResponse } from 'next/server';
import { sendSmsNotification } from '@/lib/notifications';
import {
  SMS_KEYWORD_CONFIRM,
  SMS_KEYWORD_HELP,
  SMS_KEYWORD_OPT_IN,
  SMS_KEYWORD_STOP,
  confirmationSms,
  helpSms,
  stopSms,
  welcomeSms,
} from '@/lib/sms-compliance';
import { upsertSmsOptIn } from '@/lib/sms-opt-in-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function twiml(message: string): NextResponse {
  const escaped = message
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  const xml = `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escaped}</Message></Response>`;
  return new NextResponse(xml, {
    status: 200,
    headers: { 'Content-Type': 'text/xml; charset=utf-8' },
  });
}

/**
 * Twilio Messaging webhook (incoming SMS).
 * Configure in Twilio Console → Phone number → Messaging →
 * "A message comes in" Webhook: https://app.estimateace.com/api/sms/inbound
 */
export async function POST(request: NextRequest) {
  try {
    const contentType = request.headers.get('content-type') || '';
    let from = '';
    let bodyText = '';

    if (contentType.includes('application/json')) {
      const json = await request.json().catch(() => ({}));
      from = String(json.From || json.from || '');
      bodyText = String(json.Body || json.body || '');
    } else {
      const form = await request.formData();
      from = String(form.get('From') || '');
      bodyText = String(form.get('Body') || '');
    }

    const keyword = bodyText.trim().toUpperCase().split(/\s+/)[0] || '';

    if (keyword === SMS_KEYWORD_OPT_IN || keyword === 'UNSTOP' || keyword === 'SUBSCRIBE') {
      // Pending until they reply YES
      await upsertSmsOptIn({
        phone: from,
        optedIn: false,
        method: 'sms_keyword_pending',
        source: keyword,
        pendingConfirm: true,
      });
      return twiml(welcomeSms('EstimateAce'));
    }

    if (keyword === SMS_KEYWORD_CONFIRM) {
      await upsertSmsOptIn({
        phone: from,
        optedIn: true,
        method: 'sms_keyword_yes',
        source: 'YES',
        pendingConfirm: false,
      });
      return twiml(confirmationSms('EstimateAce'));
    }

    if (keyword === SMS_KEYWORD_STOP || keyword === 'CANCEL' || keyword === 'UNSUBSCRIBE' || keyword === 'END') {
      await upsertSmsOptIn({
        phone: from,
        optedIn: false,
        method: 'sms_keyword_stop',
        source: keyword,
      });
      return twiml(stopSms());
    }

    if (keyword === SMS_KEYWORD_HELP || keyword === 'INFO') {
      return twiml(helpSms());
    }

    return twiml(
      `EstimateAce: Text ${SMS_KEYWORD_OPT_IN} to opt in, ${SMS_KEYWORD_STOP} to opt out, or ${SMS_KEYWORD_HELP} for help.`
    );
  } catch (e: any) {
    console.error('sms inbound:', e);
    return twiml('EstimateAce: Sorry, something went wrong. Reply HELP for support.');
  }
}

/** Health / Twilio validation sometimes uses GET */
export async function GET() {
  return NextResponse.json({
    ok: true,
    keywords: [SMS_KEYWORD_OPT_IN, SMS_KEYWORD_CONFIRM, SMS_KEYWORD_STOP, SMS_KEYWORD_HELP],
  });
}
