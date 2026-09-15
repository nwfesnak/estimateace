import { NextRequest } from 'next/server';
import {
  loadCallSession,
  saveCallSession,
  transcriptToText,
} from '@/lib/receptionist-call-session';
import { runReceptionistVoiceTurn } from '@/lib/receptionist-voice-agent';
import { appendReceptionistLead } from '@/lib/receptionist-leads';
import {
  sayGatherTwiml,
  sayHangupTwiml,
  transferTwiml,
  twimlXmlResponse,
  VOICE_GATHER_PATH,
} from '@/lib/receptionist-twiml';
import { formatPhoneE164 } from '@/lib/notifications';

export const dynamic = 'force-dynamic';
export const maxDuration = 55;
export const runtime = 'nodejs';

const MAX_TURNS = 14;

/**
 * POST /api/webhooks/twilio/voice/think
 * Grok turn after gather stashed pendingCallerText.
 */
export async function POST(request: NextRequest) {
  try {
    let callSid = request.nextUrl.searchParams.get('CallSid') || '';
    try {
      const form = await request.formData();
      if (!callSid) callSid = String(form.get('CallSid') || '');
    } catch {
      /* query param only */
    }
    callSid = callSid.trim();

    console.info('voice think', { callSid: callSid.slice(0, 34) });

    const session = callSid ? await loadCallSession(callSid) : null;
    if (!session) {
      return twimlXmlResponse(
        sayGatherTwiml({
          say: 'Thanks for calling. How can I help you?',
          gatherActionUrl: VOICE_GATHER_PATH,
        })
      );
    }

    const callerText = String(session.pendingCallerText || '').trim();
    session.pendingCallerText = '';

    if (!callerText) {
      return twimlXmlResponse(
        sayGatherTwiml({
          say: 'How can I help you today?',
          gatherActionUrl: VOICE_GATHER_PATH,
        })
      );
    }

    if (/^Pressed 0$/i.test(callerText)) {
      const transferE164 = formatPhoneE164(session.transferNumber || '') || '';
      if (transferE164) {
        return twimlXmlResponse(
          transferTwiml({
            say: 'Connecting you now.',
            transferTo: transferE164,
            callerId: session.to || undefined,
          })
        );
      }
    }

    session.transcript.push({ role: 'caller', text: callerText });
    session.turn = (session.turn || 0) + 1;

    if (session.turn > MAX_TURNS) {
      const bye = 'Thanks for calling. We will follow up soon. Goodbye.';
      session.transcript.push({ role: 'agent', text: bye });
      try {
        await saveCallSession(session);
      } catch {
        /* ignore */
      }
      return twimlXmlResponse(sayHangupTwiml(bye));
    }

    const transferE164 = formatPhoneE164(session.transferNumber || '') || '';

    let result;
    try {
      result = await runReceptionistVoiceTurn({
        businessName: session.businessName,
        knowledgeBase: session.knowledgeBase,
        greetingStyle: session.greeting,
        languages: session.languages,
        urgentKeywords: session.urgentKeywords,
        callerPhone: session.from,
        transcript: session.transcript,
        callerMessage: callerText,
        transferAvailable: Boolean(transferE164),
      });
    } catch (e) {
      console.error('voice think grok:', e);
      result = {
        say: 'Thanks. Could you tell me your name and what you need help with?',
        action: 'continue' as const,
        lead: null,
      };
    }

    let speak = String(result.say || '').trim();
    if (!speak || speak.startsWith('{') || speak.includes('"action"')) {
      speak = 'Thanks. How can I help with your project today?';
    }
    speak = speak.slice(0, 280);

    session.transcript.push({ role: 'agent', text: speak });

    // Lead write must never crash the call
    try {
      if (result.lead && (result.lead.notes || result.lead.name)) {
        const lead = await appendReceptionistLead({
          userId: session.userId,
          callerName: result.lead.name || '',
          callerPhone: session.from,
          summary:
            [result.lead.notes, result.lead.address].filter(Boolean).join(' · ') || speak,
          actionItems: ['Follow up from live AI call'],
          transcript: transcriptToText(session.transcript),
          urgent: Boolean(result.lead.urgent),
          source: 'voice',
        });
        if (lead?.id) session.leadIds = [...(session.leadIds || []), lead.id];
      }
    } catch (e) {
      console.warn('voice think lead:', e);
    }

    try {
      await saveCallSession(session);
    } catch (e) {
      console.warn('voice think save session:', e);
    }

    if (result.action === 'transfer' && transferE164) {
      return twimlXmlResponse(
        transferTwiml({
          say: speak,
          transferTo: transferE164,
          callerId: session.to || undefined,
        })
      );
    }

    if (result.action === 'end') {
      return twimlXmlResponse(sayHangupTwiml(speak || 'Thanks for calling. Goodbye.'));
    }

    return twimlXmlResponse(
      sayGatherTwiml({
        say: speak,
        gatherActionUrl: VOICE_GATHER_PATH,
      })
    );
  } catch (e: any) {
    console.error('voice think fatal:', e?.message || e);
    return twimlXmlResponse(
      sayGatherTwiml({
        say: 'Sorry about that. How can I help you?',
        gatherActionUrl: VOICE_GATHER_PATH,
      })
    );
  }
}
