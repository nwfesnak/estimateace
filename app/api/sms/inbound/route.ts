import { NextRequest, NextResponse } from 'next/server';
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
import { twilioWebhookUrl, validateTwilioSignature } from '@/lib/twilio-signature';

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
    const authToken = (process.env.TWILIO_AUTH_TOKEN || '').trim();
    const contentType = request.headers.get('content-type') || '';
    const params: Record<string, string> = {};
    let from = '';
    let bodyText = '';

    if (contentType.includes('application/json')) {
      const json = await request.json().catch(() => ({}));
      for (const [k, v] of Object.entries(json || {})) {
        if (v != null) params[k] = String(v);
      }
      from = String(json.From || json.from || '');
      bodyText = String(json.Body || json.body || '');
    } else {
      const form = await request.formData();
      form.forEach((value, key) => {
        params[key] = String(value);
      });
      from = String(form.get('From') || '');
      bodyText = String(form.get('Body') || '');
    }

    if (authToken) {
      const signature = request.headers.get('x-twilio-signature');
      const url = twilioWebhookUrl(request, 'https://app.estimateace.com/api/sms/inbound');
      const ok = validateTwilioSignature({ authToken, signature, url, params });
      if (!ok) {
        console.warn('sms inbound: invalid Twilio signature');
        return new NextResponse('Forbidden', { status: 403 });
      }
    } else if (process.env.NODE_ENV === 'production' || process.env.VERCEL) {
      return new NextResponse('Twilio not configured', { status: 503 });
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
  return NextResponse.json({ ok: true, service: 'sms-inbound' });
}
