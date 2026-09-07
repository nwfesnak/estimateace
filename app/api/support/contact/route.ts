import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/supabase/auth-user';
import { sendEmailNotification } from '@/lib/notifications';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function supportInbox(): string {
  return (
    (process.env.ADMIN_EMAIL || '').trim() ||
    (process.env.SUPPORT_EMAIL || '').trim() ||
    (process.env.NEXT_PUBLIC_SUPPORT_EMAIL || '').trim() ||
    'support@estimateace.com'
  );
}

/**
 * Logged-in users send billing/support messages without exposing admin inbox in the client bundle.
 */
export async function POST(request: NextRequest) {
  try {
    const { user, error } = await getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: error || 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));
    const subject = String(body.subject || 'EstimateAce help').trim().slice(0, 200);
    const message = String(body.message || '').trim().slice(0, 8000);
    const company = String(body.company || '').trim().slice(0, 200);
    const profileEmail = String(body.profileEmail || '').trim().slice(0, 200);
    const billingStatus = String(body.billingStatus || '').trim().slice(0, 80);

    if (!message) {
      return NextResponse.json({ error: 'Please enter a message.' }, { status: 400 });
    }

    const to = supportInbox();
    const text = [
      message,
      '',
      '---',
      `Company: ${company || '(not set)'}`,
      `Profile email: ${profileEmail || '(not set)'}`,
      `Account: ${user.email || '(unknown)'}`,
      `User id: ${user.id}`,
      `Billing status: ${billingStatus || 'unknown'}`,
    ].join('\n');

    const result = await sendEmailNotification(to, `[Support] ${subject}`, text, {
      replyTo: user.email || profileEmail || undefined,
      companyName: 'EstimateAce Support',
    });

    if (!result.ok) {
      return NextResponse.json(
        { error: result.error || 'Could not send message. Try again later.' },
        { status: 502 }
      );
    }

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error('support/contact:', e);
    return NextResponse.json({ error: e?.message || 'Failed' }, { status: 500 });
  }
}
