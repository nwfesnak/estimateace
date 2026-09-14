import { NextRequest, NextResponse } from 'next/server';
import { findReceptionistByPhoneNumber } from '@/lib/receptionist-store';
import { appendReceptionistLead } from '@/lib/receptionist-leads';
import { escapeXml } from '@/lib/receptionist-twiml';

export const dynamic = 'force-dynamic';

/**
 * POST /api/webhooks/twilio/sms
 * Resolve contractor by To, write Inbox lead, reply briefly.
 */
export async function POST(request: NextRequest) {
  try {
    const form = await request.formData();
    const to = String(form.get('To') || '');
    const from = String(form.get('From') || '');
    const body = String(form.get('Body') || '').slice(0, 2000);

    const tenant = to ? await findReceptionistByPhoneNumber(to) : null;
    const business = tenant?.config.branding.businessName || 'us';

    if (tenant?.userId) {
      await appendReceptionistLead({
        userId: tenant.userId,
        callerPhone: from,
        summary: body.slice(0, 280) || 'SMS received',
        actionItems: ['Reply to SMS lead'],
        transcript: `SMS from ${from}: ${body}`,
        urgent: /urgent|emergency|asap/i.test(body),
        source: 'sms',
      });
    }

    const reply = tenant
      ? `Thanks for texting ${business}. We received your message and will follow up soon.`
      : 'Thanks for your message.';

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>${escapeXml(reply)}</Message>
</Response>`;

    return new NextResponse(twiml, {
      status: 200,
      headers: { 'Content-Type': 'text/xml' },
    });
  } catch (e: any) {
    console.error('twilio sms webhook:', e);
    return new NextResponse(
      `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`,
      { status: 200, headers: { 'Content-Type': 'text/xml' } }
    );
  }
}
