import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Validate a Twilio webhook signature (X-Twilio-Signature).
 *
 * Twilio signs `url + sorted(key + value)` with HMAC-SHA1 using the auth token of the
 * account that owns the phone number, then base64-encodes it. This is the same algorithm
 * as `twilio.validateRequest` (see scripts/test-receptionist-spam.test.mjs, which
 * cross-checks against Twilio's published example).
 * @see https://www.twilio.com/docs/usage/security#validating-requests
 */
export function computeTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>
): string {
  const sortedKeys = Object.keys(params).sort();
  let data = url;
  for (const key of sortedKeys) {
    data += key + (params[key] ?? '');
  }
  return createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
}

export function validateTwilioSignature(opts: {
  authToken: string;
  signature: string | null;
  url: string;
  params: Record<string, string>;
}): boolean {
  const { authToken, signature, url, params } = opts;
  if (!authToken || !signature) return false;
  const expected = computeTwilioSignature(authToken, url, params);
  try {
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function cleanBase(raw: string | undefined | null): string {
  const v = String(raw || '').trim().replace(/\/$/, '');
  if (!v) return '';
  return v.startsWith('http') ? v : `https://${v}`;
}

/**
 * Every public URL Twilio may have signed for this request. Behind Vercel the
 * function sees an internal URL, so we rebuild it from configured bases and the
 * forwarded proto/host headers. Path + raw query string are always kept.
 */
export function twilioCandidateUrls(request: Request): string[] {
  let pathAndQuery = '/';
  let direct = '';
  try {
    const u = new URL(request.url);
    pathAndQuery = `${u.pathname}${u.search}`;
    direct = u.toString();
  } catch {
    /* ignore */
  }
  const headers = request.headers;
  const fwdHost = (headers.get('x-forwarded-host') || headers.get('host') || '')
    .split(',')[0]
    .trim();
  const fwdProto = (headers.get('x-forwarded-proto') || 'https').split(',')[0].trim();
  const bases = [
    cleanBase(process.env.TWILIO_WEBHOOK_BASE_URL),
    cleanBase(process.env.NEXT_PUBLIC_APP_URL),
    fwdHost ? `${fwdProto}://${fwdHost}` : '',
    cleanBase(process.env.VERCEL_PROJECT_PRODUCTION_URL),
    'https://app.estimateace.com',
  ].filter(Boolean);
  const out = new Set<string>();
  for (const b of bases) out.add(`${b}${pathAndQuery}`);
  if (direct) out.add(direct);
  return [...out];
}

/** True when any (token, url) pair produces the signature Twilio sent. */
export function validateTwilioAgainstCandidates(opts: {
  tokens: string[];
  urls: string[];
  signature: string | null;
  params: Record<string, string>;
}): boolean {
  if (!opts.signature) return false;
  for (const token of opts.tokens) {
    if (!token) continue;
    for (const url of opts.urls) {
      if (validateTwilioSignature({ authToken: token, signature: opts.signature, url, params: opts.params })) {
        return true;
      }
    }
  }
  return false;
}

/** Build absolute webhook URL Twilio used (prefer configured public app URL). */
export function twilioWebhookUrl(request: Request, pathFallback: string): string {
  const configured = (process.env.NEXT_PUBLIC_APP_URL || '').trim().replace(/\/$/, '');
  if (configured) {
    const u = new URL(request.url);
    return `${configured}${u.pathname}${u.search}`;
  }
  try {
    return new URL(request.url).toString();
  } catch {
    return pathFallback;
  }
}
