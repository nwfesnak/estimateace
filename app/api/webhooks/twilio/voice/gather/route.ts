import { NextRequest, NextResponse } from 'next/server';
import { loadCallSession, saveCallSession } from '@/lib/receptionist-call-session';
import { sayGatherTwiml, sayHangupTwiml, sayThenRedirectTwiml } from '@/lib/receptionist-twiml';
import { getReceptionistWebhookBase } from '@/lib/twilio-receptionist-provision';

export const dynamic = 'force-dynamic';
export const maxDuration = 15;

/**
 * POST /api/webhooks/twilio/voice/gather
 * Fast path: capture SpeechResult, stash on session, ack Twilio immediately,
 * then Redirect to /think (where Grok runs). Avoids Twilio's ~15s action timeout.
 */
export async function POST(request: NextRequest) {
  try {
    const form = await request.formData();
    const callSid = String(form.get('CallSid') || '');
    const speech = String(
      form.get('SpeechResult') ||
        form.get('UnstableSpeechResult') ||
        form.get('StableSpeechResult') ||
        ''
    ).trim();
    const digits = String(form.get('Digits') || '').trim();
    const confidence = String(form.get('Confidence') || '');

    console.info('voice gather:', {
      callSid,
      speech: speech.slice(0, 120),
      digits,
      confidence,
    });

    const session = callSid ? await loadCallSession(callSid) : null;
    const base = getReceptionistWebhookBase();
    const gatherUrl = `${base}/api/webhooks/twilio/voice/gather`;
    const thinkUrl = `${base}/api/webhooks/twilio/voice/think`;

    if (!session) {
      return xml(sayHangupTwiml('Thanks for calling. Please try again in a moment.'));
    }

    // DTMF 0 / * → treat as request for human (handled in think)
    const callerText = speech || (digits ? `Pressed ${digits}` : '');

    if (!callerText) {
      const emptyCount = (session.emptyListenCount || 0) + 1;
      session.emptyListenCount = emptyCount;
      await saveCallSession(session);

      if (emptyCount >= 3) {
        const bye =
          'I am having trouble hearing you. Please call back, or leave a message with your name and number. Goodbye.';
        return xml(sayHangupTwiml(bye));
      }

      return xml(
        sayGatherTwiml({
          say: "Sorry, I didn't catch that. Please speak clearly after the beep — for example, say your name and what you need.",
          gatherActionUrl: gatherUrl,
        })
      );
    }

    session.pendingCallerText = callerText;
    session.emptyListenCount = 0;
    await saveCallSession(session);

    // Quick ack so Twilio does not time out while Grok thinks
    return xml(
      sayThenRedirectTwiml({
        say: 'One moment please.',
        redirectUrl: thinkUrl,
      })
    );
  } catch (e: any) {
    console.error('voice gather:', e);
    return xml(sayHangupTwiml('We are sorry. Something went wrong. Please try again later.'));
  }
}

function xml(twiml: string) {
  return new NextResponse(twiml, {
    status: 200,
    headers: { 'Content-Type': 'text/xml' },
  });
}
