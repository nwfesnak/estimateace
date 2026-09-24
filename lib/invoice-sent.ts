/**
 * Invoice send mark — stored on the document profile so no DB migration is required.
 * Only set after email or text actually goes out.
 */

export function readInvoiceSentAt(row: any): string | null {
  if (!row) return null;
  const profile = row.profile && typeof row.profile === 'object' ? row.profile : {};
  const raw = String(
    row.invoiceSentAt ||
      row.invoicesentat ||
      profile._invoiceSentAt ||
      profile.invoiceSentAt ||
      ''
  ).trim();
  return raw || null;
}

export function invoiceSentLabel(sentAt: string): string {
  const d = new Date(sentAt);
  if (Number.isNaN(d.getTime())) return 'Sent';
  return `Sent ${d.toLocaleString()}`;
}
