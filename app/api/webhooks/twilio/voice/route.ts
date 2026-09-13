import { NextRequest, NextResponse } from 'next/server';
import { findReceptionistByPhoneNumber } from '@/lib/receptionist-store';
import { validateTwilioSignature, twilioWebhookUrl } from '@/lib/twilio-signature';

export const dynamic = 'force-dynamic';

/**
 * POST /api/webhooks/twilio/voice
 * Phase 1: resolve contractor by To number and return simple TwiML greeting.
 * Phase 2 will connect Media Stream / ConversationRelay to the AI agent.
 */
export async function POST(request: NextRequest) {
  try {
    const form = await request.formData();
    const params: Record<string, string> = {};
    form.forEach((v, k) => {
      params[k] = String(v);
    });

    const to = params.To || '';
    const from = params.From || '';
    const authToken = (process.env.TWILIO_AUTH_TOKEN || '').trim();
    const signature = request.headers.get('x-twilio-signature') || '';

    // Master token validates platform webhooks; subaccount calls still hit this URL.
    // Phase 2: validate with subaccount token from TenantResolver.
    if (authToken && signature) {
      const url = twilioWebhookUrl(request, '/api/webhooks/twilio/voice');
      const ok = validateTwilioSignature({ authToken, signature, url, params });
      if (!ok) {
        console.warn('twilio voice: signature mismatch (continuing in Phase 1 for subaccount calls)');
      }
    }

    const tenant = to ? await findReceptionistByPhoneNumber(to) : null;
    const business =
      tenant?.config.branding.businessName ||
      tenant?.config.branding.businessName ||
      'this business';
    const greeting =
      (tenant?.config.branding.greeting || '').trim() ||
      `Thanks for calling ${business}. Our AI receptionist line is active. Please leave your name, phone number, and a short message after the tone, and we will get back to you soon.`;

    const say = escapeXml(greeting.slice(0, 500));
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">${say}</Say>
  <Pause length="1"/>
  <Say voice="Polly.Joanna">Full live AI conversation is coming next. Goodbye.</Say>
  <Hangup/>
</Response>`;

    console.info('twilio voice:', { to, from, contractorId: tenant?.userId || null });

    return new NextResponse(twiml, {
      status: 200,
      headers: { 'Content-Type': 'text/xml' },
    });
  } catch (e: any) {
    console.error('twilio voice webhook:', e);
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response><Say>We are sorry. This line is temporarily unavailable.</Say><Hangup/></Response>`;
    return new NextResponse(twiml, { status: 200, headers: { 'Content-Type': 'text/xml' } });
  }
}

function escapeXml(s: string) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
