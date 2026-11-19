/**
 * Numbers the AI receptionist may ring or transfer callers to (owner cell, business
 * line). Only US and Canada (+1) numbers are allowed: forwarding to international,
 * Caribbean (+1 809, 876, ...) or premium-rate (900 / 976) numbers would bill the
 * platform's Twilio account at international / premium rates (toll fraud).
 */
import { CANADA_AREA_CODES, CARIBBEAN_NANP_AREA_CODES, isUsPhoneE164 } from '@/lib/rate-limit';

const PREMIUM_AREA_CODES = new Set(['900', '976']);

export const FORWARD_NUMBER_ERROR =
  'Call-forward numbers must be a US or Canada phone number (+1, 10 digits), for example (555) 123-4567.';

/** +1XXXXXXXXXX for a US/Canada number, else null. Accepts common formatting. */
export function forwardDialNumber(raw: string | null | undefined): string | null {
  const input = String(raw || '').trim();
  if (!input) return null;
  // Anything written with a non-+1 country code is refused outright.
  if (input.startsWith('+') && !input.startsWith('+1')) return null;
  if (/^0{2}/.test(input.replace(/[\s().-]/g, ''))) return null; // 00 international prefix
  const digits = input.replace(/\D/g, '');
  let national: string;
  if (digits.length === 10) national = digits;
  else if (digits.length === 11 && digits.startsWith('1')) national = digits.slice(1);
  else return null;
  const e164 = `+1${national}`;
  if (!/^\+1[2-9]\d{2}[2-9]\d{6}$/.test(e164)) return null;
  const area = national.slice(0, 3);
  if (PREMIUM_AREA_CODES.has(area) || CARIBBEAN_NANP_AREA_CODES.has(area)) return null;
  if (isUsPhoneE164(e164) || CANADA_AREA_CODES.has(area)) return e164;
  return null;
}

/**
 * Validate a call-forward number from the settings form: '' clears it, a valid number
 * is stored as +1 E.164, anything else is an error.
 */
export function normalizeForwardNumberInput(
  raw: unknown
): { ok: true; value: string } | { ok: false; error: string } {
  const input = String(raw ?? '').trim();
  if (!input) return { ok: true, value: '' };
  const e164 = forwardDialNumber(input);
  return e164 ? { ok: true, value: e164 } : { ok: false, error: FORWARD_NUMBER_ERROR };
}
