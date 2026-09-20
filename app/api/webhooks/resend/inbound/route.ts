/**
 * Resend inbound webhook — email.received
 * Configure in Resend: https://app.estimateace.com/api/webhooks/resend/inbound
 * Event: email.received
 *
 * Users forward ANY inbox (Gmail, Outlook, Yahoo, etc.) to their unique
 * u{userIdHex}@EMAIL_INBOUND_DOMAIN address.
 */
import { NextRequest, NextResponse } from 'next/server';
import {
  appendEmailLeadSummary,
  fetchResendReceivedEmail,
  parseFromHeader,
  resolveUserIdFromRecipients,
  summarizeInboundEmail,
} from '@/lib/email-inbound';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

function verifyOptionalSecret(request: NextRequest): boolean {
  const secret = process.env.RESEND_WEBHOOK_SECRET?.trim();
  if (!secret) return true; // soft-launch: allow until secret is set
  const header =
    request.headers.get('resend-signature') ||
    request.headers.get('x-resend-signature') ||
    request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ||
    '';
  const query = request.nextUrl.searchParams.get('secret') || '';
  return timingSafeEqual(header, secret) || timingSafeEqual(query, secret);
}

export async function POST(request: NextRequest) {
  try {
    if (!verifyOptionalSecret(request)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const payload = await request.json().catch(() => null);
    if (!payload || typeof payload !== 'object') {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const type = String((payload as any).type || '');
    if (type && type !== 'email.received') {
      return NextResponse.json({ ok: true, ignored: type });
    }

    const data = (payload as any).data || payload;
    const emailId = String(data.email_id || data.id || '').trim();
    const metaFrom = String(data.from || '');
    const metaSubject = String(data.subject || '(no subject)');
    const metaTo = Array.isArray(data.to) ? data.to.map(String) : [];
    const metaReceivedFor = Array.isArray(data.received_for)
      ? data.received_for.map(String)
      : [];

    let bodyText = '';
    let from = metaFrom;
    let subject = metaSubject;
    let to = metaTo;
    let receivedFor = metaReceivedFor;

    if (emailId) {
      const full = await fetchResendReceivedEmail(emailId);
      if (full) {
        from = full.from || from;
        subject = full.subject || subject;
        bodyText = full.text || '';
        to = full.to.length ? full.to : to;
        receivedFor = full.received_for.length ? full.received_for : receivedFor;
      }
    }

    const userId = resolveUserIdFromRecipients([...receivedFor, ...to]);
    if (!userId) {
      console.warn('inbound email: no matching EstimateAce user for', {
        to,
        receivedFor,
        subject,
      });
      return NextResponse.json({ ok: true, matched: false });
    }

    const { name, email } = parseFromHeader(from);
    const summary = await summarizeInboundEmail({
      subject,
      fromName: name,
      fromEmail: email,
      bodyText,
    });

    const saved = await appendEmailLeadSummary({
      userId,
      fromName: name,
      fromEmail: email,
      subject,
      summary,
    });

    return NextResponse.json({
      ok: true,
      matched: true,
      saved: Boolean(saved),
      id: saved?.id || null,
    });
  } catch (e: any) {
    console.error('resend inbound webhook:', e);
    return NextResponse.json(
      { error: e?.message || 'Inbound processing failed' },
      { status: 500 }
    );
  }
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    service: 'resend-inbound',
    hint: 'POST email.received events from Resend here',
  });
}
