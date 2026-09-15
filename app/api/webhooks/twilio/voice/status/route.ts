import { NextRequest, NextResponse } from 'next/server';
import {
  deleteCallSession,
  loadCallSession,
  transcriptToText,
} from '@/lib/receptionist-call-session';
import { summarizeVoiceCall } from '@/lib/receptionist-voice-agent';
import { appendReceptionistLead } from '@/lib/receptionist-leads';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** POST /api/webhooks/twilio/voice/status — finalize call session → inbox lead */
export async function POST(request: NextRequest) {
  try {
    const form = await request.formData();
    const status = String(form.get('CallStatus') || '');
    const callSid = String(form.get('CallSid') || '');
    const to = String(form.get('To') || '');
    console.info('twilio voice status:', { status, callSid, to });

    const terminal = ['completed', 'busy', 'no-answer', 'failed', 'canceled'].includes(status);
    if (!terminal || !callSid) {
      return new NextResponse('', { status: 204 });
    }

    const session = await loadCallSession(callSid);
    if (!session) {
      return new NextResponse('', { status: 204 });
    }

    // Always write/update a final lead with name, phone, address when possible
    if (session.transcript?.length) {
      const summary = await summarizeVoiceCall({
        businessName: session.businessName,
        transcript: session.transcript,
        callerPhone: session.from,
        urgentKeywords: session.urgentKeywords,
        collectedName: session.collectedName,
        collectedPhone: session.collectedPhone,
        collectedAddress: session.collectedAddress,
      });
      const name = summary.callerName || session.collectedName || 'Unknown';
      const phone = summary.callerPhone || session.collectedPhone || session.from;
      const address = summary.address || session.collectedAddress || '';
      await appendReceptionistLead({
        userId: session.userId,
        callerName: name,
        callerPhone: phone,
        address,
        summary: [
          `Name: ${name}`,
          `Phone: ${phone}`,
          address ? `Address: ${address}` : null,
          summary.summary ? `Notes: ${summary.summary}` : null,
        ]
          .filter(Boolean)
          .join('\n'),
        actionItems: summary.actionItems?.length
          ? summary.actionItems
          : ['Follow up with caller'],
        transcript: transcriptToText(session.transcript),
        urgent: summary.urgent,
        language: summary.language,
        source: 'voice',
      });
    }

    await deleteCallSession(callSid);
  } catch (e) {
    console.warn('twilio voice status:', e);
  }
  return new NextResponse('', { status: 204 });
}
