/**
 * Shared X-Twilio-Signature check for the AI receptionist webhooks
 * (voice, gate, gather, think, status, SMS).
 *
 * Receptionist numbers live in per-contractor Twilio subaccounts, and Twilio signs
 * webhooks with the auth token of the account that owns the number. So we accept
 * the master TWILIO_AUTH_TOKEN and the contractor's subaccount token.
 */
import { NextResponse } from 'next/server';
import { loadReceptionistSecretsRow } from '@/lib/receptionist-store';
import { twilioCandidateUrls, validateTwilioAgainstCandidates } from '@/lib/twilio-signature';

export async function readTwilioParams(request: Request): Promise<Record<string, string>> {
  const params: Record<string, string> = {};
  try {
    const form = await request.formData();
    form.forEach((v, k) => {
      params[k] = String(v);
    });
  } catch {
    /* empty body (e.g. redirect with query only) */
  }
  return params;
}

function devBypass(): boolean {
  return (
    !process.env.VERCEL &&
    process.env.NODE_ENV !== 'production' &&
    ['1', 'true', 'yes'].includes(
      String(process.env.TWILIO_WEBHOOK_SKIP_SIGNATURE || '').trim().toLowerCase()
    )
  );
}

/**
 * Returns null when the request is genuinely from Twilio, otherwise a 403 (or 503
 * when no token is configured on a deployed server) response to return as-is.
 */
export async function verifyTwilioWebhook(
  request: Request,
  params: Record<string, string>,
  opts: { userId?: string | null; label: string }
): Promise<Response | null> {
  if (devBypass()) return null;

  const tokens: string[] = [];
  const master = (process.env.TWILIO_AUTH_TOKEN || '').trim();
  if (master) tokens.push(master);
  if (opts.userId) {
    try {
      const row = await loadReceptionistSecretsRow(opts.userId);
      const sub = String(row?.secrets?.subaccountAuthToken || '').trim();
      if (sub && !tokens.includes(sub)) tokens.push(sub);
    } catch (e) {
      console.warn(`${opts.label}: could not load subaccount token`, e);
    }
  }

  if (!tokens.length) {
    console.error(`${opts.label}: no Twilio auth token configured; rejecting webhook`);
    return new NextResponse('Twilio not configured', { status: 503 });
  }

  const ok = validateTwilioAgainstCandidates({
    tokens,
    urls: twilioCandidateUrls(request),
    signature: request.headers.get('x-twilio-signature'),
    params,
  });
  if (!ok) {
    console.warn(`${opts.label}: invalid X-Twilio-Signature`, {
      hasSignature: Boolean(request.headers.get('x-twilio-signature')),
      accountSid: String(params.AccountSid || '').slice(0, 10),
    });
    return new NextResponse('Forbidden', { status: 403 });
  }
  return null;
}
