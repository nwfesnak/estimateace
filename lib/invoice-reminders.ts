/**
 * Unpaid sent invoices: follow-up email and text on the contractor's cadence
 * until paid. 0 = only the manual Send. 2, 4, or 6 = repeat that many days.
 */

import { readInvoiceSentAt } from '@/lib/invoice-sent';
import { computeDocumentGrandTotal } from '@/lib/document-totals';

export const INVOICE_REMINDER_INTERVAL_MS = 2 * 24 * 60 * 60 * 1000;

export type InvoiceReminderDays = 0 | 2 | 4 | 6;

/** Missing or unknown values stay on the original every-2-days cadence. */
export function normalizeInvoiceReminderDays(value: unknown): InvoiceReminderDays {
  const n = typeof value === 'string' ? Number(value.trim()) : Number(value);
  if (n === 0 || n === 2 || n === 4 || n === 6) return n;
  return 2;
}

export function firstInvoiceReminderDays(...values: unknown[]): InvoiceReminderDays {
  for (const value of values) {
    if (value === undefined || value === null || value === '') continue;
    const n = typeof value === 'string' ? Number(value.trim()) : Number(value);
    if (n === 0 || n === 2 || n === 4 || n === 6) return n;
  }
  return 2;
}

export function invoiceReminderIntervalMs(days: InvoiceReminderDays): number {
  if (days === 0) return 0;
  return days * 24 * 60 * 60 * 1000;
}

export function readInvoiceLastReminderAt(row: any): string | null {
  if (!row) return null;
  const profile = profileOf(row);
  const raw = String(profile._invoiceLastReminderAt || profile.invoiceLastReminderAt || '').trim();
  return raw || null;
}

export function readInvoiceReminderCount(row: any): number {
  const n = Number(profileOf(row)._invoiceReminderCount);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export function isInvoiceDocument(row: any): boolean {
  if (!row) return false;
  const id = String(row.id || '');
  if (id.toUpperCase().startsWith('SETTINGS')) return false;
  const type = String(row.documentType ?? row.documenttype ?? '').toLowerCase();
  const num = String(row.invoiceNumber ?? row.invoicenumber ?? row.id ?? '');
  return type === 'invoice' || num.toUpperCase().startsWith('INV-') || num.toUpperCase().startsWith('INV');
}

export function isInvoiceMarkedPaid(row: any): boolean {
  const status = String(row?.paymentStatus ?? row?.paymentstatus ?? '').toLowerCase();
  return status === 'paid';
}

/** Card checkout writes the payment itself. Cash, Venmo, Zelle, and check do not. */
const AUTO_LOGGED_METHODS = new Set(['stripe', 'card', 'credit card', 'creditcard']);

export function isAutoLoggedPayment(row: any): boolean {
  const method = String(row?.paymentMethod ?? row?.paymentmethod ?? '')
    .trim()
    .toLowerCase();
  return AUTO_LOGGED_METHODS.has(method);
}

/**
 * Stop reminders when the invoice is marked paid, or when a card payment
 * was logged and covers the balance. Other methods wait for Mark paid.
 */
export function isInvoiceSettledForReminders(row: any): boolean {
  if (isInvoiceMarkedPaid(row)) return true;
  if (!isAutoLoggedPayment(row)) return false;
  let items = row?.items;
  if (typeof items === 'string') {
    try {
      items = JSON.parse(items);
    } catch {
      items = [];
    }
  }
  const total = computeDocumentGrandTotal({
    ...row,
    items: Array.isArray(items) ? items : [],
  });
  const paid = Number(row?.amountPaid ?? row?.amountpaid) || 0;
  if (total > 0.009) return paid >= total - 0.009;
  return paid > 0.009;
}

/** True when a reminder email and text should go out now. */
export function invoiceReminderDue(
  row: any,
  now = Date.now(),
  intervalDays?: unknown
): boolean {
  const days = normalizeInvoiceReminderDays(
    intervalDays !== undefined ? intervalDays : profileOf(row).invoiceReminderDays
  );
  if (days === 0) return false;
  if (!isInvoiceDocument(row) || isInvoiceSettledForReminders(row)) return false;
  const sentMs = Date.parse(readInvoiceSentAt(row) || '');
  if (!Number.isFinite(sentMs)) return false;
  const lastRaw = readInvoiceLastReminderAt(row);
  const anchor = lastRaw ? Date.parse(lastRaw) : sentMs;
  if (!Number.isFinite(anchor)) return false;
  return now - anchor >= invoiceReminderIntervalMs(days);
}

export function invoiceReminderHint(
  row: any,
  now = Date.now(),
  intervalDays?: unknown
): string {
  const sent = readInvoiceSentAt(row);
  if (!sent || isInvoiceSettledForReminders(row)) return '';
  const days = normalizeInvoiceReminderDays(
    intervalDays !== undefined ? intervalDays : profileOf(row).invoiceReminderDays
  );
  const stopNote =
    'Card payments stop these automatically. For cash, Venmo, Zelle, or check, mark the invoice paid when the money arrives.';
  if (days === 0) {
    return `Sent ${new Date(sent).toLocaleString()}. Automatic follow-ups are off, so another email goes out only when you click Send. ${stopNote}`;
  }
  const every = `every ${days} days`;
  const last = readInvoiceLastReminderAt(row);
  if (last && !Number.isNaN(Date.parse(last))) {
    return `Reminder emailed and texted ${new Date(last).toLocaleString()}. Another goes out ${every}. ${stopNote}`;
  }
  const sentMs = Date.parse(sent);
  if (!Number.isFinite(sentMs)) return '';
  const firstAt = sentMs + invoiceReminderIntervalMs(days);
  if (now >= firstAt) {
    return `A reminder email and text is due, then ${every}. ${stopNote}`;
  }
  return `Reminder email and text ${new Date(firstAt).toLocaleString()}, then ${every}. ${stopNote}`;
}

export function profileOf(row: any): Record<string, any> {
  const raw = row?.profile;
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      /* ignore */
    }
  }
  return {};
}

export function recipientEmails(row: any): string[] {
  return uniqueStrings(row?.emails ?? row?.email).filter((v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v));
}

export function recipientPhones(row: any): string[] {
  return uniqueStrings(row?.phones ?? row?.phone).filter((v) => v.replace(/\D/g, '').length >= 10);
}

function uniqueStrings(value: unknown): string[] {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const text = String(item || '').trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}
