/**
 * Unpaid sent invoices: first reminder 2 days after send, then every 2 days until paid.
 */

import { readInvoiceSentAt } from '@/lib/invoice-sent';

export const INVOICE_REMINDER_INTERVAL_MS = 2 * 24 * 60 * 60 * 1000;

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

/** True when a reminder email and text should go out now. */
export function invoiceReminderDue(row: any, now = Date.now()): boolean {
  if (!isInvoiceDocument(row) || isInvoiceMarkedPaid(row)) return false;
  const sentMs = Date.parse(readInvoiceSentAt(row) || '');
  if (!Number.isFinite(sentMs)) return false;
  const lastRaw = readInvoiceLastReminderAt(row);
  const anchor = lastRaw ? Date.parse(lastRaw) : sentMs;
  if (!Number.isFinite(anchor)) return false;
  return now - anchor >= INVOICE_REMINDER_INTERVAL_MS;
}

export function invoiceReminderHint(row: any, now = Date.now()): string {
  const sent = readInvoiceSentAt(row);
  if (!sent || isInvoiceMarkedPaid(row)) return '';
  const last = readInvoiceLastReminderAt(row);
  if (last && !Number.isNaN(Date.parse(last))) {
    return `Reminder emailed and texted ${new Date(last).toLocaleString()}. Another goes out every 2 days until this invoice is marked paid.`;
  }
  const sentMs = Date.parse(sent);
  if (!Number.isFinite(sentMs)) return '';
  const firstAt = sentMs + INVOICE_REMINDER_INTERVAL_MS;
  if (now >= firstAt) {
    return 'A reminder email and text is due. Another goes out every 2 days until this invoice is marked paid.';
  }
  return `Reminder email and text ${new Date(firstAt).toLocaleString()}, then every 2 days until this invoice is marked paid.`;
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
