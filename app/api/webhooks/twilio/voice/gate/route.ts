import { NextRequest } from 'next/server';
import { loadCallSession, saveCallSession } from '@/lib/receptionist-call-session';
import { findReceptionistByPhoneNumber } from '@/lib/receptionist-store';
import {
  pressOneGateTwiml,
  sayGatherTwiml,
  twimlResponse,
  twimlXmlResponse,
  VOICE_GATHER_PATH,
} from '@/lib/receptionist-twiml';
import { readTwilioParams, verifyTwilioWebhook } from '@/lib/twilio-webhook-auth';

export const dynamic = 'force-dynamic';
export const maxDuration = 20;
export const runtime = 'nodejs';

const MAX_GATE_ATTEMPTS = 2;

/**
 * POST /api/webhooks/twilio/voice/gate
 * Keypad result of the "press 1" gate. 1 → AI receptionist greets the caller.
 * Anything else → one more prompt, then hang up (no lead).
 */
export async function POST(request: NextRequest) {
  const params = await readTwilioParams(request);
  const callSid = String(params.CallSid || '').trim();
  const session = callSid ? await loadCallSession(callSid).catch(() => null) : null;
  let userId = session?.userId || '';
  if (!userId && params.To) {
    userId = (await findReceptionistByPhoneNumber(params.To).catch(() => null))?.userId || '';
  }
  const denied = await verifyTwilioWebhook(request, params, { userId, label: 'twilio voice gate' });
  if (denied) return denied;

  const digits = String(params.Digits || '').trim();
  const business = session?.businessName || 'our office';

  if (digits !== '1') {
    const attempts = (session?.gateAttempts || 0) + 1;
    if (session) {
      session.gateAttempts = attempts;
      try {
        await saveCallSession(session);
      } catch (e) {
        console.warn('voice gate save attempts:', e);
      }
    }
    if (attempts >= MAX_GATE_ATTEMPTS || !session) {
      return twimlXmlResponse(twimlResponse('  <Hangup/>'));
    }
    return twimlXmlResponse(pressOneGateTwiml({ businessName: business, retry: true }));
  }

  if (!session) {
    return twimlXmlResponse(twimlResponse('  <Hangup/>'));
  }
  const greeting = 'Thanks! What are you calling about today?';
  {
    session.gatePassed = true;
    session.transcript = [...(session.transcript || []), { role: 'agent', text: greeting }];
    try {
      await saveCallSession(session);
    } catch (e) {
      console.warn('voice gate save passed:', e);
    }
  }
  console.info('voice gate passed', { callSid: callSid.slice(0, 34) });
  return twimlXmlResponse(sayGatherTwiml({ say: greeting, gatherActionUrl: VOICE_GATHER_PATH }));
}
