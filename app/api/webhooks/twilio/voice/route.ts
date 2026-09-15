import { NextRequest } from 'next/server';
import { findReceptionistByPhoneNumber } from '@/lib/receptionist-store';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { saveCallSession } from '@/lib/receptionist-call-session';
import {
  sayGatherTwiml,
  sayHangupTwiml,
  transferTwiml,
  twimlXmlResponse,
  VOICE_GATHER_PATH,
} from '@/lib/receptionist-twiml';
import { fillGreeting } from '@/lib/ai-receptionist';
import { formatPhoneE164 } from '@/lib/notifications';
import { receptionistAddonHasAccess } from '@/lib/receptionist-billing';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;
export const runtime = 'nodejs';

function digitsOnly(phone: string) {
  return String(phone || '').replace(/\D/g, '');
}

function sameNumber(a: string, b: string) {
  const da = digitsOnly(a);
  const db = digitsOnly(b);
  if (!da || !db) return false;
  return da === db || da.slice(-10) === db.slice(-10);
}

function toE164(phone: string): string | null {
  const raw = String(phone || '').trim();
  if (!raw) return null;
  return formatPhoneE164(raw) || (raw.startsWith('+') ? raw : null);
}

/**
 * POST /api/webhooks/twilio/voice
 * - AI On  → live receptionist (relative Gather URLs — avoids bad NEXT_PUBLIC_APP_URL)
 * - AI Off → silent Dial to host/business/cell
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
      return twimlXmlResponse(
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
    const explicitlyOff = classicEnabled === false;
    const aiSettingsEnabled =
      !explicitlyOff &&
      (classicEnabled === true ||
        tenant.config.enabled === true ||
        (classicEnabled !== false &&
          hasAiLine &&
          (addonActive || tenant.config.status === 'active')));

    const aiLine = tenant.config.twilio?.phoneNumber || to;

    const hostCandidates = [
      tenant.config.transferNumber || '',
      tenant.config.publicBusinessNumber || '',
      profilePhone || '',
    ];
    const hostRing =
      hostCandidates
        .map((n) => toE164(n))
        .find((n) => n && !sameNumber(n, aiLine) && !sameNumber(n, to)) || '';

    if (!aiSettingsEnabled) {
      console.info('twilio voice AI off → silent dial host', {
        to,
        from,
        callSid,
        contractorId: tenant.userId,
        hostRing: hostRing || null,
      });
      if (hostRing) {
        return twimlXmlResponse(
          transferTwiml({
            silent: true,
            transferTo: hostRing,
            callerId: to || undefined,
            timeoutSec: 45,
          })
        );
      }
      return twimlXmlResponse(
        sayHangupTwiml(
          'Thanks for calling. No one is available to take your call right now. Please try again later.'
        )
      );
    }

    const business = tenant.config.branding.businessName || 'our company';
    const rawGreeting =
      (tenant.config.branding.greeting || '').trim() ||
      aiGreeting ||
      `Thanks for calling {company}. This is the AI receptionist.`;
    // Casual open — gather name/phone/address/need naturally across turns
    const greetingBase = fillGreeting(rawGreeting, business).replace(/\s+/g, ' ').trim();
    const greeting = (
      /\?\s*$/.test(greetingBase)
        ? greetingBase
        : `${greetingBase} How can I help you today?`
    ).slice(0, 400);

    const transferForAi =
      [tenant.config.transferNumber || '', profilePhone]
        .map((n) => toE164(n))
        .find((n) => n && !sameNumber(n, aiLine) && !sameNumber(n, to)) || '';

    if (callSid) {
      try {
        await saveCallSession({
          callSid,
          userId: tenant.userId,
          from,
          to,
          businessName: business,
          transferNumber: transferForAi || tenant.config.transferNumber || '',
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
      } catch (e) {
        console.warn('voice save session:', e);
      }
    }

    console.info('twilio voice AI on:', { to, from, callSid, contractorId: tenant.userId });

    return twimlXmlResponse(
      sayGatherTwiml({
        say: greeting,
        gatherActionUrl: VOICE_GATHER_PATH,
      })
    );
  } catch (e: any) {
    console.error('twilio voice webhook:', e);
    return twimlXmlResponse(
      sayHangupTwiml('We are sorry. This line is temporarily unavailable.')
    );
  }
}
