import { NextRequest, NextResponse } from 'next/server';
import {
  loadCallSession,
  saveCallSession,
  transcriptToText,
} from '@/lib/receptionist-call-session';
import { runReceptionistVoiceTurn } from '@/lib/receptionist-voice-agent';
import { appendReceptionistLead } from '@/lib/receptionist-leads';
import { sayGatherTwiml, sayHangupTwiml, transferTwiml } from '@/lib/receptionist-twiml';
import { getReceptionistWebhookBase } from '@/lib/twilio-receptionist-provision';
import { formatPhoneE164 } from '@/lib/notifications';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const MAX_TURNS = 14;

/**
 * POST /api/webhooks/twilio/voice/think
 * Runs Grok on pendingCallerText and continues the call (Say+Gather / Dial / Hangup).
 */
export async function POST(request: NextRequest) {
  try {
    // Twilio Redirect may POST form fields; CallSid is what we need
    let callSid = '';
    try {
      const form = await request.formData();
      callSid = String(form.get('CallSid') || '');
    } catch {
      callSid = request.nextUrl.searchParams.get('CallSid') || '';
    }

    // Fallback: if Redirect dropped CallSid, try reading from recent — can't; require CallSid
    const session = callSid ? await loadCallSession(callSid) : null;
    const gatherUrl = `${getReceptionistWebhookBase()}/api/webhooks/twilio/voice/gather`;

    if (!session) {
      return xml(sayHangupTwiml('Thanks for calling. Please try again in a moment.'));
    }

    const callerText = String(session.pendingCallerText || '').trim();
    session.pendingCallerText = '';

    if (!callerText) {
      return xml(
        sayGatherTwiml({
          say: 'How can I help you today?',
          gatherActionUrl: gatherUrl,
        })
      );
    }

    // Human request via keypad 0
    if (/^Pressed 0$/i.test(callerText) || /press(?:ed)? 0/i.test(callerText)) {
      const transferE164 = formatPhoneE164(session.transferNumber || '') || '';
      if (transferE164) {
        return xml(
          transferTwiml({
            say: 'Okay, connecting you now.',
            transferTo: transferE164,
            callerId: session.to || undefined,
          })
        );
      }
    }

    session.transcript.push({ role: 'caller', text: callerText });
    session.turn = (session.turn || 0) + 1;

    if (session.turn > MAX_TURNS) {
      const bye =
        'Thanks for calling. I have your information and we will follow up soon. Goodbye.';
      session.transcript.push({ role: 'agent', text: bye });
      await saveCallSession(session);
      await finalizeLeadFromSession(session);
      return xml(sayHangupTwiml(bye));
    }

    const transferE164 = formatPhoneE164(session.transferNumber || '') || '';
    const result = await runReceptionistVoiceTurn({
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

    // Never speak raw JSON if model misfires
    let speak = String(result.say || '').trim();
    if (speak.startsWith('{') || speak.includes('"action"')) {
      speak = 'Thanks — how can I help you with your project today?';
    }

    session.transcript.push({ role: 'agent', text: speak });

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

    await saveCallSession(session);

    if (result.action === 'transfer' && transferE164) {
      return xml(
        transferTwiml({
          say: speak || 'Please hold while I connect you.',
          transferTo: transferE164,
          callerId: session.to || undefined,
        })
      );
    }

    if (result.action === 'end') {
      if (!(session.leadIds || []).length) {
        await finalizeLeadFromSession(session);
      }
      return xml(sayHangupTwiml(speak || 'Thanks for calling. Goodbye.'));
    }

    return xml(
      sayGatherTwiml({
        say: speak,
        gatherActionUrl: gatherUrl,
      })
    );
  } catch (e: any) {
    console.error('voice think:', e);
    return xml(
      sayGatherTwiml({
        say: 'Sorry about that. Could you say that one more time?',
        gatherActionUrl: `${getReceptionistWebhookBase()}/api/webhooks/twilio/voice/gather`,
      })
    );
  }
}

async function finalizeLeadFromSession(
  session: NonNullable<Awaited<ReturnType<typeof loadCallSession>>>
) {
  if ((session.leadIds || []).length > 0) return;
  const text = transcriptToText(session.transcript);
  if (!text.trim()) return;
  await appendReceptionistLead({
    userId: session.userId,
    callerPhone: session.from,
    summary: text.slice(0, 280),
    transcript: text,
    actionItems: ['Review live call'],
    source: 'voice',
  });
}

function xml(twiml: string) {
  return new NextResponse(twiml, {
    status: 200,
    headers: { 'Content-Type': 'text/xml' },
  });
}
