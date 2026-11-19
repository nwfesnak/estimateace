import { NextRequest } from 'next/server';
import { findReceptionistByPhoneNumber } from '@/lib/receptionist-store';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { saveCallSession } from '@/lib/receptionist-call-session';
import {
  pressOneGateTwiml,
  rejectTwiml,
  sayGatherTwiml,
  sayHangupTwiml,
  transferTwiml,
  twimlXmlResponse,
  VOICE_GATHER_PATH,
} from '@/lib/receptionist-twiml';
import { receptionistScreeningFlags } from '@/lib/ai-receptionist';
import { isCallerBlocked } from '@/lib/receptionist-blocklist';
import { readTwilioParams, verifyTwilioWebhook } from '@/lib/twilio-webhook-auth';
import { forwardDialNumber } from '@/lib/phone-forward';
import { loadReceptionistBilling, receptionistAddonHasAccess } from '@/lib/receptionist-billing';

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

/** Only US/Canada numbers are ever dialed (no international / premium transfers). */
function toE164(phone: string): string | null {
  return forwardDialNumber(phone);
}

/**
 * POST /api/webhooks/twilio/voice
 * - Signed by Twilio (X-Twilio-Signature) or 403
 * - Blocked caller (owner hit "Mark as spam") → <Reject/>, no lead
 * - AI On  → optional "press 1" gate, then live receptionist (relative Gather URLs)
 * - AI Off → silent Dial to host/business/cell
 */
export async function POST(request: NextRequest) {
  const params = await readTwilioParams(request);
  const to = params.To || '';
  const from = params.From || '';
  const callSid = params.CallSid || '';

  let tenant: Awaited<ReturnType<typeof findReceptionistByPhoneNumber>> = null;
  try {
    tenant = to ? await findReceptionistByPhoneNumber(to) : null;
  } catch (e) {
    console.warn('twilio voice tenant lookup:', e);
  }

  const denied = await verifyTwilioWebhook(request, params, {
    userId: tenant?.userId,
    label: 'twilio voice',
  });
  if (denied) return denied;

  try {
    if (!tenant) {
      return twimlXmlResponse(
        sayHangupTwiml(
          'Thanks for calling. This line is not set up yet. Please try again later.'
        )
      );
    }

    const admin = getSupabaseAdmin();
    let knowledgeBase = '';
    let websiteUrl = '';
    let urgentKeywords =
      'emergency, leak, no heat, no ac, flooding, urgent, asap, fire, smoke';
    let languages = ['en', 'es'];
    let aiGreeting = '';
    let profilePhone = '';
    let classicEnabled: boolean | null = null;
    let addonActive = false;
    let companyName = '';
    let screening = receptionistScreeningFlags(null);

    if (admin) {
      const { data } = await admin
        .from('estimates')
        .select('profile')
        .eq('id', `SETTINGS-${tenant.userId}`)
        .maybeSingle();
      const profile = (data?.profile || {}) as any;
      const ai = profile.aiReceptionist || {};
      knowledgeBase = String(ai.knowledgeBase || '').slice(0, 10000);
      websiteUrl = String(ai.websiteUrl || '').trim().slice(0, 500);
      if (ai.urgentKeywords) urgentKeywords = String(ai.urgentKeywords);
      if (Array.isArray(ai.languages) && ai.languages.length) languages = ai.languages.map(String);
      aiGreeting = String(ai.greeting || '');
      profilePhone = String(profile.phone || '');
      if (typeof ai.enabled === 'boolean') classicEnabled = ai.enabled;
      companyName = String(profile.company || '').trim();
      screening = receptionistScreeningFlags(ai);
    }
    // Entitlement comes only from server-only storage written by Stripe webhooks/sync
    // (never from the user-editable SETTINGS row).
    addonActive = receptionistAddonHasAccess(await loadReceptionistBilling(tenant.userId));

    if (from && (await isCallerBlocked(tenant.userId, from))) {
      console.info('twilio voice: blocked caller rejected', {
        callSid,
        contractorId: tenant.userId,
      });
      return twimlXmlResponse(rejectTwiml());
    }

    const hasAiLine = Boolean(tenant.config.twilio?.phoneNumber);
    const explicitlyOff = classicEnabled === false;
    const aiSettingsEnabled =
      addonActive &&
      hasAiLine &&
      !explicitlyOff &&
      (classicEnabled === true ||
        tenant.config.enabled === true ||
        tenant.config.status === 'active');

    if (!addonActive) {
      // Add-on not paid (or lapsed): don't run AI and don't keep forwarding on our Twilio bill.
      console.info('twilio voice: receptionist add-on inactive', {
        callSid,
        contractorId: tenant.userId,
      });
      return twimlXmlResponse(
        sayHangupTwiml(
          'Thanks for calling. This line is not available right now. Please call the business directly.'
        )
      );
    }

    const aiLine = tenant.config.twilio?.phoneNumber || to;

    const hostCandidates = [
      tenant.config.transferNumber || '',
      profilePhone || '',
      tenant.config.publicBusinessNumber || '',
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

    // Current Company Profile name wins over the copy saved when the line was enabled.
    const business =
      companyName ||
      (tenant.config.branding.businessName !== 'Your Company'
        ? tenant.config.branding.businessName
        : '') ||
      'our company';
    const rawGreeting = (
      (tenant.config.branding.greeting || '').trim() ||
      aiGreeting ||
      `Thanks for calling {company}. What are you calling about today?`
    ).replace(/\{company\}/gi, business);
    // Staged script open — ask why they are calling (need stage)
    const greeting = (
      `Thanks for calling ${business}. What are you calling about today?`
    ).slice(0, 400);
    const gateRequired = screening.pressOneGate;

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
          transferNumber: transferForAi || '',
          knowledgeBase,
          websiteUrl,
          greeting: rawGreeting,
          urgentKeywords,
          languages,
          transcript: gateRequired ? [] : [{ role: 'agent', text: greeting }],
          leadIds: [],
          turn: 0,
          callStage: 'need',
          spamScreening: screening.spamScreening,
          gateRequired,
          gatePassed: !gateRequired,
          gateAttempts: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      } catch (e) {
        console.warn('voice save session:', e);
      }
    }

    console.info('twilio voice AI on:', {
      to,
      from,
      callSid,
      contractorId: tenant.userId,
      gate: gateRequired,
    });

    if (gateRequired) {
      return twimlXmlResponse(pressOneGateTwiml({ businessName: business }));
    }

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
