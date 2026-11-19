/**
 * Calendar-date helpers for documents (estimates, invoices, receipts).
 *
 * `new Date().toISOString().slice(0, 10)` gives the *UTC* date, which is
 * already "tomorrow" for US contractors every evening (after 7–8 PM Eastern).
 * Use these helpers whenever a "today" YYYY-MM-DD is generated, and when a
 * stored date-only string needs to become a Date (so it isn't parsed as UTC
 * midnight and shown a day early).
 */

/** Used on the server when the account has no stored timezone. */
export const DEFAULT_BUSINESS_TIME_ZONE = 'America/New_York';

const pad2 = (n: number) => String(n).padStart(2, '0');

/** YYYY-MM-DD from a Date's *local* (runtime) calendar fields. */
export function toLocalDateKey(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** YYYY-MM-DD for `d` as seen in an IANA time zone (e.g. America/New_York). */
export function dateKeyInTimeZone(
  d: Date = new Date(),
  timeZone: string = DEFAULT_BUSINESS_TIME_ZONE
): string {
  try {
    // en-CA formats as YYYY-MM-DD
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(d);
  } catch {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: DEFAULT_BUSINESS_TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(d);
  }
}

/**
 * Today's calendar date for a document.
 * - In the browser: the contractor's device-local date.
 * - On the server (Vercel runs in UTC): the given zone, else America/New_York.
 */
export function todayDateKey(timeZone?: string | null): string {
  if (timeZone) return dateKeyInTimeZone(new Date(), timeZone);
  if (typeof window !== 'undefined') return toLocalDateKey(new Date());
  return dateKeyInTimeZone(new Date(), DEFAULT_BUSINESS_TIME_ZONE);
}

/**
 * Parse a stored date. Date-only strings ('YYYY-MM-DD', optionally followed by
 * time) are read as a *local* calendar day instead of UTC midnight, so
 * '2026-01-01' stays Jan 1 (and in 2026) rather than becoming Dec 31, 2025
 * in US time zones. Returns null when unparseable.
 */
export function parseDateOnly(raw: unknown): Date | null {
  if (raw == null || raw === '') return null;
  if (raw instanceof Date) return isNaN(raw.getTime()) ? null : raw;
  const s = String(raw).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) {
    const dt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return isNaN(dt.getTime()) ? null : dt;
  }
  const dt = new Date(s);
  return isNaN(dt.getTime()) ? null : dt;
}
