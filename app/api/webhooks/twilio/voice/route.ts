import { NextRequest, NextResponse } from 'next/server';
import { findReceptionistByPhoneNumber } from '@/lib/receptionist-store';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { saveCallSession } from '@/lib/receptionist-call-session';
import { getReceptionistWebhookBase } from '@/lib/twilio-receptionist-provision';
import { sayGatherTwiml, sayHangupTwiml, transferTwiml } from '@/lib/receptionist-twiml';
import { fillGreeting } from '@/lib/ai-receptionist';
import { formatPhoneE164 } from '@/lib/notifications';
import { receptionistAddonHasAccess } from '@/lib/receptionist-billing';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

function digitsOnly(phone: string) {
  return String(phone || '').replace(/\D/g, '');
}

function sameNumber(a: string, b: string) {
  const da = digitsOnly(a);
  const db = digitsOnly(b);
  if (!da || !db) return false;
  return da === db || da.slice(-10) === db.slice(-10);
}

/**
 * POST /api/webhooks/twilio/voice
 *
 * Customers advertise their business number and forward it here.
 * - Receptionist On (or paid + line provisioned and not explicitly Off) → AI answers
 * - Explicitly Off → dial owner CELL (never the business/AI number — that causes a loop)
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
    let classicEnabled: boolean | null = null;
    let addonActive = false;

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
      if (typeof ai.enabled === 'boolean') classicEnabled = ai.enabled;
      addonActive =
        profile.aiReceptionistAddonActive === true ||
        receptionistAddonHasAccess(profile.receptionistBilling);
    }

    const hasAiLine = Boolean(tenant.config.twilio?.phoneNumber);
    // Answer with AI when:
    // - toggle explicitly On, OR
    // - toggle never set / true via config.enabled, OR
    // - paid + line exists and not explicitly Off
    const explicitlyOff = classicEnabled === false && tenant.config.enabled === false;
    const aiSettingsEnabled =
      !explicitlyOff &&
      (classicEnabled === true ||
        tenant.config.enabled === true ||
        (classicEnabled !== false && hasAiLine && (addonActive || tenant.config.status === 'active')));

    const aiLine = tenant.config.twilio?.phoneNumber || to;
    const publicBiz = tenant.config.publicBusinessNumber || '';

    // Owner ring target must NOT be the AI line or the public business number
    // (business number usually forwards back here → endless "please hold")
    const ownerCandidates = [tenant.config.transferNumber || '', profilePhone].filter(Boolean);
    const ownerRing =
      ownerCandidates
        .map((n) => formatPhoneE164(n) || n)
        .find((n) => n && !sameNumber(n, aiLine) && !sameNumber(n, publicBiz) && !sameNumber(n, to)) ||
      '';

    if (!aiSettingsEnabled) {
      console.info('twilio voice AI off', {
        to,
        from,
        callSid,
        contractorId: tenant.userId,
        classicEnabled,
        configEnabled: tenant.config.enabled,
        ownerRing: ownerRing || null,
      });
      if (ownerRing) {
        return xml(
          transferTwiml({
            say: 'The AI receptionist is turned off. Please hold while we connect you to the business.',
            transferTo: ownerRing,
            callerId: to || undefined,
          })
        );
      }
      return xml(
        sayHangupTwiml(
          'Thanks for calling. The AI receptionist is turned off right now, and no backup number is set. Please try again later.'
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
        transferNumber: ownerRing || tenant.config.transferNumber || '',
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
