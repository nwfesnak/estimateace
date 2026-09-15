import { NextRequest } from 'next/server';
import { loadCallSession, saveCallSession } from '@/lib/receptionist-call-session';
import {
  sayGatherTwiml,
  sayHangupTwiml,
  sayThenRedirectTwiml,
  twimlXmlResponse,
  VOICE_GATHER_PATH,
  VOICE_THINK_PATH,
} from '@/lib/receptionist-twiml';

export const dynamic = 'force-dynamic';
export const maxDuration = 20;
export const runtime = 'nodejs';

/**
 * POST /api/webhooks/twilio/voice/gather
 * Capture speech quickly → redirect to /think?CallSid=... (Grok runs there).
 */
export async function POST(request: NextRequest) {
  try {
    const form = await request.formData();
    const callSid = String(form.get('CallSid') || '').trim();
    const speech = String(
      form.get('SpeechResult') ||
        form.get('UnstableSpeechResult') ||
        form.get('StableSpeechResult') ||
        ''
    ).trim();
    const digits = String(form.get('Digits') || '').trim();

    console.info('voice gather ok', {
      callSid: callSid.slice(0, 34),
      speechLen: speech.length,
      speechPreview: speech.slice(0, 80),
      digits,
    });

    const session = callSid ? await loadCallSession(callSid) : null;

    if (!session) {
      // Still listen again instead of hard-failing the call
      return twimlXmlResponse(
        sayGatherTwiml({
          say: 'Thanks for calling. How can I help you today?',
          gatherActionUrl: VOICE_GATHER_PATH,
        })
      );
    }

    const callerText = speech || (digits ? `Pressed ${digits}` : '');

    if (!callerText) {
      const emptyCount = (session.emptyListenCount || 0) + 1;
      session.emptyListenCount = emptyCount;
      try {
        await saveCallSession(session);
      } catch (e) {
        console.warn('gather save empty count:', e);
      }

      if (emptyCount >= 3) {
        return twimlXmlResponse(
          sayHangupTwiml(
            'I am having trouble hearing you. Please call back later. Goodbye.'
          )
        );
      }

      return twimlXmlResponse(
        sayGatherTwiml({
          say: "Sorry, I didn't catch that. Please say your name and what you need.",
          gatherActionUrl: VOICE_GATHER_PATH,
        })
      );
    }

    session.pendingCallerText = callerText.slice(0, 2000);
    session.emptyListenCount = 0;
    try {
      await saveCallSession(session);
    } catch (e) {
      console.warn('gather save pending speech:', e);
    }

    // Pass CallSid in query so /think always has it even if form body is odd
    const thinkUrl = `${VOICE_THINK_PATH}?CallSid=${encodeURIComponent(callSid)}`;
    return twimlXmlResponse(
      sayThenRedirectTwiml({
        say: 'One moment.',
        redirectUrl: thinkUrl,
      })
    );
  } catch (e: any) {
    console.error('voice gather fatal:', e?.message || e);
    return twimlXmlResponse(
      sayGatherTwiml({
        say: 'Sorry about that. How can I help you?',
        gatherActionUrl: VOICE_GATHER_PATH,
      })
    );
  }
}
