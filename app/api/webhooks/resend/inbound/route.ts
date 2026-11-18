/**
 * Resend inbound webhook — email.received
 * Configure in Resend: https://app.estimateace.com/api/webhooks/resend/inbound
 * Event: email.received
 * Security: set RESEND_WEBHOOK_SECRET (the webhook's whsec_... signing secret from
 * Resend → Webhooks) so only signed requests from Resend are accepted.
 *
 * Users forward ANY inbox (Gmail, Outlook, Yahoo, etc.) to their unique
 * u{userIdHex}@EMAIL_INBOUND_DOMAIN address.
 */
import { createHmac, timingSafeEqual } from 'crypto';
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

/** Max clock skew accepted for svix-timestamp (seconds), same as the svix library. */
const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

/**
 * Verify Resend's webhook signature (Resend signs with Svix).
 * Signed content is `${svix-id}.${svix-timestamp}.${rawBody}`, HMAC-SHA256 with the
 * base64 part of the `whsec_...` signing secret; header `svix-signature` holds one or
 * more space-separated `v1,<base64sig>` entries.
 *
 * RESEND_WEBHOOK_SECRET unset → allowed (soft launch, logs a warning).
 * RESEND_WEBHOOK_SECRET set   → unsigned / bad / stale requests are rejected.
 */
function verifyResendSignature(request: NextRequest, rawBody: string): { ok: boolean; reason?: string } {
  const secret = process.env.RESEND_WEBHOOK_SECRET?.trim();
  if (!secret) {
    console.warn('resend inbound: RESEND_WEBHOOK_SECRET not set — accepting unsigned webhook');
    return { ok: true };
  }
  const id = request.headers.get('svix-id') || request.headers.get('webhook-id') || '';
  const ts = request.headers.get('svix-timestamp') || request.headers.get('webhook-timestamp') || '';
  const sigHeader =
    request.headers.get('svix-signature') || request.headers.get('webhook-signature') || '';
  if (!id || !ts || !sigHeader) return { ok: false, reason: 'Missing signature headers' };

  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) return { ok: false, reason: 'Bad timestamp' };
  if (Math.abs(Math.floor(Date.now() / 1000) - tsNum) > SIGNATURE_TOLERANCE_SECONDS) {
    return { ok: false, reason: 'Stale timestamp' };
  }

  let key: Buffer;
  try {
    key = Buffer.from(secret.startsWith('whsec_') ? secret.slice(6) : secret, 'base64');
  } catch {
    return { ok: false, reason: 'Bad secret' };
  }
  const expected = createHmac('sha256', key).update(`${id}.${ts}.${rawBody}`).digest();

  for (const part of sigHeader.split(' ')) {
    const [version, sig] = part.split(',');
    if (version !== 'v1' || !sig) continue;
    let given: Buffer;
    try {
      given = Buffer.from(sig, 'base64');
    } catch {
      continue;
    }
    if (given.length === expected.length && timingSafeEqual(given, expected)) return { ok: true };
  }
  return { ok: false, reason: 'Signature mismatch' };
}

export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.text();
    const verified = verifyResendSignature(request, rawBody);
    if (!verified.ok) {
      console.warn('resend inbound: rejected webhook —', verified.reason);
      return NextResponse.json({ error: 'Invalid webhook signature' }, { status: 401 });
    }

    let payload: unknown = null;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      payload = null;
    }
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
