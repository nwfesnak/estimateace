import { NextRequest, NextResponse } from 'next/server';
import { findReceptionistByPhoneNumber } from '@/lib/receptionist-store';
import { appendReceptionistLead } from '@/lib/receptionist-leads';
import { escapeXml } from '@/lib/receptionist-twiml';
import { isCallerBlocked } from '@/lib/receptionist-blocklist';
import { readTwilioParams, verifyTwilioWebhook } from '@/lib/twilio-webhook-auth';
import { loadReceptionistBilling, receptionistAddonHasAccess } from '@/lib/receptionist-billing';

export const dynamic = 'force-dynamic';

function emptyTwiml() {
  return new NextResponse(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`, {
    status: 200,
    headers: { 'Content-Type': 'text/xml' },
  });
}

/**
 * POST /api/webhooks/twilio/sms
 * Signed by Twilio or 403. Resolve contractor by To, write Inbox lead, reply briefly.
 * Blocked numbers get no lead and no reply.
 */
export async function POST(request: NextRequest) {
  const params = await readTwilioParams(request);
  const to = String(params.To || '');
  const from = String(params.From || '');
  const body = String(params.Body || '').slice(0, 2000);

  const tenant = to ? await findReceptionistByPhoneNumber(to).catch(() => null) : null;
  const denied = await verifyTwilioWebhook(request, params, {
    userId: tenant?.userId,
    label: 'twilio sms',
  });
  if (denied) return denied;

  try {
    const business = tenant?.config.branding.businessName || 'us';

    if (tenant?.userId && from && (await isCallerBlocked(tenant.userId, from))) {
      console.info('twilio sms: blocked sender ignored', { contractorId: tenant.userId });
      return emptyTwiml();
    }

    if (tenant?.userId) {
      await appendReceptionistLead({
        userId: tenant.userId,
        callerPhone: from,
        summary: body.slice(0, 280) || 'SMS received',
        actionItems: ['Reply to SMS lead'],
        transcript: `SMS from ${from}: ${body}`,
        urgent: /urgent|emergency|asap/i.test(body),
        source: 'sms',
        fromNumber: from,
        ...(params.MessageSid ? { id: `sms-${String(params.MessageSid).slice(0, 64)}` } : {}),
      });

      // Unpaid / lapsed add-on: still keep the inbound lead, but do not auto-reply
      // (no outbound SMS on an unpaid line).
      const billing = await loadReceptionistBilling(tenant.userId);
      if (!receptionistAddonHasAccess(billing)) {
        console.info('twilio sms: add-on inactive, lead saved, no auto-reply', {
          contractorId: tenant.userId,
        });
        return emptyTwiml();
      }
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
    return emptyTwiml();
  }
}
