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

    // If we never created a lead mid-call, write a summary lead now
    if (!(session.leadIds || []).length && session.transcript?.length) {
      const summary = await summarizeVoiceCall({
        businessName: session.businessName,
        transcript: session.transcript,
        callerPhone: session.from,
        urgentKeywords: session.urgentKeywords,
      });
      await appendReceptionistLead({
        userId: session.userId,
        callerName: summary.callerName,
        callerPhone: session.from,
        summary: summary.summary,
        actionItems: summary.actionItems,
        transcript: transcriptToText(session.transcript),
        urgent: summary.urgent,
        language: summary.language,
        source: 'forwarded',
      });
    }

    await deleteCallSession(callSid);
  } catch (e) {
    console.warn('twilio voice status:', e);
  }
  return new NextResponse('', { status: 204 });
}
