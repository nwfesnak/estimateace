import { createHmac, timingSafeEqual } from 'crypto';

export type ClientActionPayload = {
  /** Contractor workspace user id */
  uid: string;
  /** Document id / invoice number */
  inv: string;
  /** estimate | invoice */
  typ: 'estimate' | 'invoice';
  /** Unix ms expiry */
  exp: number;
};

function pepper(): string {
  return (
    process.env.CLIENT_ACTION_SECRET ||
    process.env.OTP_PEPPER ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.TWILIO_AUTH_TOKEN ||
    'estimateace-client-action-dev'
  );
}

function b64url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function fromB64url(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
  return Buffer.from(b64, 'base64');
}

function sign(data: string): string {
  return b64url(createHmac('sha256', pepper()).update(data).digest());
}

/** Create a long-lived client link token (default 60 days). */
export function createClientActionToken(
  payload: Omit<ClientActionPayload, 'exp'> & { expDays?: number }
): string {
  const days = Math.min(180, Math.max(1, payload.expDays ?? 60));
  const body: ClientActionPayload = {
    uid: payload.uid,
    inv: payload.inv,
    typ: payload.typ,
    exp: Date.now() + days * 24 * 60 * 60 * 1000,
  };
  const data = b64url(JSON.stringify(body));
  return `${data}.${sign(data)}`;
}

export function verifyClientActionToken(
  token: string
): { ok: true; payload: ClientActionPayload } | { ok: false; error: string } {
  const raw = String(token || '').trim();
  if (!raw || !raw.includes('.')) return { ok: false, error: 'Invalid link' };

  const [data, sig] = raw.split('.');
  if (!data || !sig) return { ok: false, error: 'Invalid link' };

  const expected = sign(data);
  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return { ok: false, error: 'Invalid or expired link' };
    }
  } catch {
    return { ok: false, error: 'Invalid link' };
  }

  try {
    const payload = JSON.parse(fromB64url(data).toString('utf8')) as ClientActionPayload;
    if (!payload?.uid || !payload?.inv) return { ok: false, error: 'Invalid link data' };
    if (!payload.exp || Date.now() > Number(payload.exp)) {
      return { ok: false, error: 'This link has expired. Ask your contractor to resend.' };
    }
    if (payload.typ !== 'invoice' && payload.typ !== 'estimate') {
      payload.typ = 'estimate';
    }
    return { ok: true, payload };
  } catch {
    return { ok: false, error: 'Invalid link' };
  }
}
