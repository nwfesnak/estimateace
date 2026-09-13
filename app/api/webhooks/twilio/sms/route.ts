import { NextRequest, NextResponse } from 'next/server';
import { findReceptionistByPhoneNumber } from '@/lib/receptionist-store';
import { getSupabaseAdmin } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

/**
 * POST /api/webhooks/twilio/sms
 * Phase 1: resolve contractor by To, store a lead-style inbox message, reply briefly.
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
      const admin = getSupabaseAdmin();
      if (admin) {
        const settingsId = `SETTINGS-${tenant.userId}`;
        const { data } = await admin.from('estimates').select('profile').eq('id', settingsId).maybeSingle();
        const profile = (data?.profile || {}) as any;
        const messages = Array.isArray(profile.aiReceptionistMessages)
          ? profile.aiReceptionistMessages
          : [];
        const msg = {
          id: `sms-${Date.now()}`,
          createdAt: new Date().toISOString(),
          callerName: '',
          callerPhone: from,
          summary: body.slice(0, 280) || 'SMS received',
          actionItems: ['Reply to SMS lead'],
          transcript: `SMS from ${from}: ${body}`,
          urgent: /urgent|emergency|asap/i.test(body),
          spam: false,
          language: 'en',
          status: 'new',
          source: 'forwarded',
        };
        await admin.from('estimates').upsert({
          id: settingsId,
          user_id: tenant.userId,
          jobName: '__settings__',
          documentType: 'settings',
          items: [],
          profile: {
            ...profile,
            aiReceptionistMessages: [msg, ...messages].slice(0, 200),
          },
          updated_at: new Date().toISOString(),
        });
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
    return new NextResponse(
      `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`,
      { status: 200, headers: { 'Content-Type': 'text/xml' } }
    );
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
