import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Validate Twilio webhook signature (X-Twilio-Signature).
 * @see https://www.twilio.com/docs/usage/security#validating-requests
 */
export function validateTwilioSignature(opts: {
  authToken: string;
  signature: string | null;
  url: string;
  params: Record<string, string>;
}): boolean {
  const { authToken, signature, url, params } = opts;
  if (!authToken || !signature) return false;

  const sortedKeys = Object.keys(params).sort();
  let data = url;
  for (const key of sortedKeys) {
    data += key + (params[key] ?? '');
  }

  const expected = createHmac('sha256', authToken).update(Buffer.from(data, 'utf8')).digest('base64');

  try {
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** Build absolute webhook URL Twilio used (prefer configured public app URL). */
export function twilioWebhookUrl(request: Request, pathFallback: string): string {
  const configured = (process.env.NEXT_PUBLIC_APP_URL || '').trim().replace(/\/$/, '');
  if (configured) {
    const path = new URL(request.url).pathname;
    return `${configured}${path}`;
  }
  // Fall back to request URL (may differ behind proxies)
  try {
    return new URL(request.url).toString().split('?')[0];
  } catch {
    return pathFallback;
  }
}
