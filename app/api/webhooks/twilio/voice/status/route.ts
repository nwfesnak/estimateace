import { NextRequest, NextResponse } from 'next/server';
import { deleteCallSession, loadCallSession } from '@/lib/receptionist-call-session';
import { finalizeReceptionistCall } from '@/lib/receptionist-call-finalize';
import { findReceptionistByPhoneNumber } from '@/lib/receptionist-store';
import { readTwilioParams, verifyTwilioWebhook } from '@/lib/twilio-webhook-auth';
import { maybeSendUsageAlerts, recordReceptionistCall } from '@/lib/receptionist-usage';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;
export const runtime = 'nodejs';

function ok() {
  // Twilio status callbacks should always get 2xx — empty 204 is fine
  return new NextResponse(null, { status: 204 });
}

/**
 * POST /api/webhooks/twilio/voice/status — call ended → one lead per CallSid.
 * Idempotent: Twilio retries and the final-turn finalizer never create a second lead.
 */
export async function POST(request: NextRequest) {
  const params = await readTwilioParams(request);
  const status = String(params.CallStatus || '');
  const callSid = String(params.CallSid || '').trim();
  const to = String(params.To || '');

  const session = callSid ? await loadCallSession(callSid).catch(() => null) : null;
  let userId = session?.userId || '';
  if (!userId && to) {
    userId = (await findReceptionistByPhoneNumber(to).catch(() => null))?.userId || '';
  }
  const denied = await verifyTwilioWebhook(request, params, { userId, label: 'twilio voice status' });
  if (denied) return denied;

  try {
    console.info('twilio voice status:', { status, callSid, to });

    const terminal = ['completed', 'busy', 'no-answer', 'failed', 'canceled'].includes(status);

    // Count the minutes against the owner's caps (once per CallSid). AI calls have a
    // session; anything else on the line (AI off, cap reached → forwarded) is "forward".
    const duration = Number(params.CallDuration) || 0;
    if (terminal && callSid && userId && duration > 0) {
      try {
        const rec = await recordReceptionistCall({
          callSid,
          userId,
          kind: session ? 'ai' : 'forward',
          durationSeconds: duration,
        });
        if (rec?.recorded && session) {
          await maybeSendUsageAlerts({
            userId,
            periodStart: rec.periodStart,
            monthAiSeconds: rec.monthAiSeconds,
          });
        }
      } catch (e) {
        console.warn('twilio voice status usage:', e);
      }
    }

    if (!terminal || !callSid || !session) {
      return ok();
    }

    try {
      await finalizeReceptionistCall(callSid, 'status_callback');
    } catch (e) {
      console.warn('twilio voice status finalize:', e);
    }

    try {
      await deleteCallSession(callSid);
    } catch (e) {
      console.warn('twilio voice status delete session:', e);
    }
  } catch (e) {
    console.warn('twilio voice status:', e);
  }
  return ok();
}
