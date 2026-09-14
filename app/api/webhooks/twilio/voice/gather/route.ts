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
 * POST /api/webhooks/twilio/voice/gather
 * SpeechResult from <Gather> → Grok receptionist turn → Say + Gather / Dial / Hangup
 */
export async function POST(request: NextRequest) {
  try {
    const form = await request.formData();
    const callSid = String(form.get('CallSid') || '');
    const speech = String(form.get('SpeechResult') || form.get('UnstableSpeechResult') || '').trim();
    const from = String(form.get('From') || '');

    const session = callSid ? await loadCallSession(callSid) : null;
    const gatherUrl = `${getReceptionistWebhookBase()}/api/webhooks/twilio/voice/gather`;

    if (!session) {
      return xml(
        sayHangupTwiml('Thanks for calling. Please try again in a moment.')
      );
    }

    const callerText = speech || '(no speech detected)';
    if (speech) {
      session.transcript.push({ role: 'caller', text: speech });
    }
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
      callerPhone: session.from || from,
      transcript: session.transcript,
      callerMessage: callerText,
      transferAvailable: Boolean(transferE164),
    });

    session.transcript.push({ role: 'agent', text: result.say });

    if (result.lead && (result.lead.notes || result.lead.name)) {
      const lead = await appendReceptionistLead({
        userId: session.userId,
        callerName: result.lead.name || '',
        callerPhone: session.from || from,
        summary: [result.lead.notes, result.lead.address].filter(Boolean).join(' · ') || result.say,
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
          say: result.say || 'Please hold while I connect you.',
          transferTo: transferE164,
          callerId: session.to || undefined,
        })
      );
    }

    if (result.action === 'end') {
      if (!(session.leadIds || []).length) {
        await finalizeLeadFromSession(session);
      }
      return xml(sayHangupTwiml(result.say || 'Thanks for calling. Goodbye.'));
    }

    return xml(
      sayGatherTwiml({
        say: result.say,
        gatherActionUrl: gatherUrl,
      })
    );
  } catch (e: any) {
    console.error('voice gather:', e);
    return xml(sayHangupTwiml('We are sorry. Something went wrong. Please try again later.'));
  }
}

async function finalizeLeadFromSession(session: NonNullable<Awaited<ReturnType<typeof loadCallSession>>>) {
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
