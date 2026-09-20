/**
 * Authenticated ingest / test for email lead summaries.
 * POST { subject?, fromName?, fromEmail?, body?, test?: true }
 */
import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/supabase/auth-user';
import {
  appendEmailLeadSummary,
  getInboundAddressForUser,
  summarizeInboundEmail,
} from '@/lib/email-inbound';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const { user } = await getUserFromRequest(request);
    if (!user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const userId = user.id;

    const body = await request.json().catch(() => ({}));
    const isTest = body?.test === true;
    const subject = String(
      body?.subject || (isTest ? 'Test lead — driveway estimate request' : '(no subject)')
    ).slice(0, 300);
    const fromName = String(
      body?.fromName || (isTest ? 'Sample Homeowner' : 'Unknown')
    ).slice(0, 120);
    const fromEmail = String(
      body?.fromEmail || (isTest ? 'homeowner@example.com' : '')
    ).slice(0, 200);
    const bodyText = String(
      body?.body ||
        (isTest
          ? 'Hi, we need a quote to sealcoat our driveway next week. Address is 123 Main St. Call me at 555-0100 when you can.'
          : '')
    ).slice(0, 8000);

    const summary =
      String(body?.summary || '').trim() ||
      (await summarizeInboundEmail({
        subject,
        fromName,
        fromEmail,
        bodyText,
      }));

    const saved = await appendEmailLeadSummary({
      userId,
      fromName,
      fromEmail,
      subject,
      summary,
    });

    if (!saved) {
      return NextResponse.json(
        { error: 'Could not save email summary (server settings unavailable).' },
        { status: 500 }
      );
    }

    return NextResponse.json({
      ok: true,
      lead: saved,
      forwardAddress: getInboundAddressForUser(userId),
    });
  } catch (e: any) {
    console.error('email-leads ingest:', e);
    return NextResponse.json({ error: e?.message || 'Failed' }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  const { user } = await getUserFromRequest(request);
  if (!user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return NextResponse.json({
    ok: true,
    forwardAddress: getInboundAddressForUser(user.id),
  });
}
