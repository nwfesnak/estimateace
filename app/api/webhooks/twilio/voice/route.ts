import { NextRequest, NextResponse } from 'next/server';
import { findReceptionistByPhoneNumber } from '@/lib/receptionist-store';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { saveCallSession } from '@/lib/receptionist-call-session';
import { getReceptionistWebhookBase } from '@/lib/twilio-receptionist-provision';
import { sayGatherTwiml, sayHangupTwiml } from '@/lib/receptionist-twiml';
import { fillGreeting } from '@/lib/ai-receptionist';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * POST /api/webhooks/twilio/voice
 * Phase 2: start live AI receptionist via Gather speech loop (Vercel-friendly).
 * Tenant resolved by To → ReceptionistConfig.twilio.phoneNumber
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
    if (!tenant || !tenant.config.enabled) {
      return xml(
        sayHangupTwiml(
          'Thanks for calling. This AI receptionist line is not active right now. Please try again later.'
        )
      );
    }

    const admin = getSupabaseAdmin();
    let knowledgeBase = '';
    let urgentKeywords =
      'emergency, leak, no heat, no ac, flooding, urgent, asap, fire, smoke';
    let languages = ['en', 'es'];
    let aiGreeting = '';
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
    }

    const business =
      tenant.config.branding.businessName ||
      'our company';
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
        transferNumber: tenant.config.transferNumber || '',
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
    console.info('twilio voice start:', { to, from, callSid, contractorId: tenant.userId });

    return xml(
      sayGatherTwiml({
        say: greeting,
        gatherActionUrl: gatherUrl,
      })
    );
  } catch (e: any) {
    console.error('twilio voice webhook:', e);
    return xml(
      sayHangupTwiml('We are sorry. This line is temporarily unavailable.')
    );
  }
}

function xml(twiml: string) {
  return new NextResponse(twiml, {
    status: 200,
    headers: { 'Content-Type': 'text/xml' },
  });
}
