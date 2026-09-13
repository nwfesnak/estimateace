import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/** POST /api/webhooks/twilio/voice/status — call completed / busy / no-answer */
export async function POST(request: NextRequest) {
  try {
    const form = await request.formData();
    const status = String(form.get('CallStatus') || '');
    const callSid = String(form.get('CallSid') || '');
    const to = String(form.get('To') || '');
    console.info('twilio voice status:', { status, callSid, to });
  } catch (e) {
    console.warn('twilio voice status parse:', e);
  }
  return new NextResponse('', { status: 204 });
}
