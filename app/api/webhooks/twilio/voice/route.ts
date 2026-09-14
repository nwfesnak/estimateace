import { NextRequest, NextResponse } from 'next/server';
import { findReceptionistByPhoneNumber } from '@/lib/receptionist-store';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { saveCallSession } from '@/lib/receptionist-call-session';
import { getReceptionistWebhookBase } from '@/lib/twilio-receptionist-provision';
import { sayGatherTwiml, sayHangupTwiml, transferTwiml } from '@/lib/receptionist-twiml';
import { fillGreeting } from '@/lib/ai-receptionist';
import { formatPhoneE164 } from '@/lib/notifications';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * POST /api/webhooks/twilio/voice
 *
 * Customers keep advertising their existing business number and forward that
 * carrier line to this Twilio AI number. We always answer on the Twilio "To"
 * number, then:
 * - AI On  → live Gather + Grok receptionist
 * - AI Off → ring the owner/transfer number so calls are not dropped
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
    const callSid = params.CallSid || '';

    const tenant = to ? await findReceptionistByPhoneNumber(to) : null;
    if (!tenant) {
      return xml(
        sayHangupTwiml(
          'Thanks for calling. This line is not set up yet. Please try again later.'
        )
      );
    }

    const admin = getSupabaseAdmin();
    let knowledgeBase = '';
    let urgentKeywords =
      'emergency, leak, no heat, no ac, flooding, urgent, asap, fire, smoke';
    let languages = ['en', 'es'];
    let aiGreeting = '';
    let profilePhone = '';
    // AI answers only when the in-app Receptionist toggle is On
    let aiSettingsEnabled = tenant.config.enabled === true;

    if (admin) {
      const { data } = await admin
        .from('estimates')
        .select('profile')
        .eq('id', `SETTINGS-${tenant.userId}`)
        .maybeSingle();
      const profile = (data?.profile || {}) as any;
      const ai = profile.aiReceptionist || {};
      knowledgeBase = String(ai.knowledgeBase || '').slice(0, 10000);
      if (ai.urgentKeywords) urgentKeywords = String(ai.urgentKeywords);
      if (Array.isArray(ai.languages) && ai.languages.length) languages = ai.languages.map(String);
      aiGreeting = String(ai.greeting || '');
      profilePhone = String(profile.phone || '');
      if (typeof ai.enabled === 'boolean') {
        aiSettingsEnabled = ai.enabled === true;
      }
    }

    const ownerRing =
      formatPhoneE164(tenant.config.transferNumber || '') ||
      formatPhoneE164(profilePhone) ||
      formatPhoneE164(tenant.config.publicBusinessNumber || '');

    // AI turned Off — still ring the owner so forwarded calls are not lost
    if (!aiSettingsEnabled) {
      if (ownerRing) {
        console.info('twilio voice AI off → dial owner', {
          to,
          from,
          callSid,
          contractorId: tenant.userId,
        });
        return xml(
          transferTwiml({
            say: 'Please hold while we connect you.',
            transferTo: ownerRing,
            callerId: to || undefined,
          })
        );
      }
      return xml(
        sayHangupTwiml(
          'Thanks for calling. No one is available to take your call right now. Please try again later.'
        )
      );
    }

    const business = tenant.config.branding.businessName || 'our company';
    const rawGreeting =
      (tenant.config.branding.greeting || '').trim() ||
      aiGreeting ||
      `Thanks for calling {company}. This is the AI receptionist. How can I help you today?`;
    const greeting = fillGreeting(rawGreeting, business).slice(0, 400);

    if (callSid) {
      await saveCallSession({
        callSid,
        userId: tenant.userId,
        from,
        to,
        businessName: business,
        transferNumber: tenant.config.transferNumber || profilePhone || '',
        knowledgeBase,
        greeting: rawGreeting,
        urgentKeywords,
        languages,
        transcript: [{ role: 'agent', text: greeting }],
        leadIds: [],
        turn: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }

    const gatherUrl = `${getReceptionistWebhookBase()}/api/webhooks/twilio/voice/gather`;
    console.info('twilio voice AI on:', { to, from, callSid, contractorId: tenant.userId });

    return xml(
      sayGatherTwiml({
        say: greeting,
        gatherActionUrl: gatherUrl,
      })
    );
  } catch (e: any) {
    console.error('twilio voice webhook:', e);
    return xml(sayHangupTwiml('We are sorry. This line is temporarily unavailable.'));
  }
}

function xml(twiml: string) {
  return new NextResponse(twiml, {
    status: 200,
    headers: { 'Content-Type': 'text/xml' },
  });
}
