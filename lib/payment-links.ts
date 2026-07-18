export type PaymentMethodSettings = {
  enabled?: boolean;
  connected?: boolean;
  /** Venmo @username, Zelle email/phone/name, etc. */
  handle?: string;
  /** Storage path or URL for a Zelle QR code image */
  qrUrl?: string;
};

export const cleanVenmoHandle = (value: string): string => value.trim().replace(/^@+/, '').trim();

export const hasVenmoHandle = (value?: string): boolean => cleanVenmoHandle(value || '').length > 0;

export const cleanZelleHandle = (value: string): string => value.trim();

export const hasZelleHandle = (value?: string): boolean => cleanZelleHandle(value || '').length > 0;

export const hasZelleSetup = (settings?: PaymentMethodSettings | null): boolean => {
  if (!settings?.enabled) return false;
  return hasZelleHandle(settings.handle) || !!String(settings.qrUrl || '').trim();
};

/** Memo/note for clients to include so the contractor can match the payment. */
export const buildZellePaymentMemo = (invoiceNumber: string, label: string, company?: string): string => {
  const parts = [company, invoiceNumber, label].map((p) => String(p || '').trim()).filter(Boolean);
  return parts.join(' · ').slice(0, 140);
};

export const buildVenmoPayUrl = (handle: string, amount: number, note: string): string => {
  const cleaned = cleanVenmoHandle(handle);
  if (!cleaned) return '';

  const params = new URLSearchParams({
    txn: 'pay',
    amount: Math.max(0, amount).toFixed(2),
    note: note.slice(0, 200),
  });

  return `https://venmo.com/${encodeURIComponent(cleaned)}?${params.toString()}`;
};

export const buildVenmoAppUrl = (handle: string, amount: number, note: string): string => {
  const cleaned = cleanVenmoHandle(handle);
  if (!cleaned) return '';

  const params = new URLSearchParams({
    txn: 'pay',
    recipients: cleaned,
    amount: Math.max(0, amount).toFixed(2),
    note: note.slice(0, 200),
  });

  return `venmo://paycharge?${params.toString()}`;
};

export const openVenmoPaymentPage = (handle: string, amount: number, note: string): boolean => {
  const cleaned = cleanVenmoHandle(handle);
  if (!cleaned) return false;

  const webUrl = buildVenmoPayUrl(cleaned, amount, note);
  const appUrl = buildVenmoAppUrl(cleaned, amount, note);
  if (!webUrl) return false;

  const isMobile =
    typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

  if (isMobile && appUrl) {
    window.location.href = appUrl;
    window.setTimeout(() => {
      window.location.href = webUrl;
    }, 900);
    return true;
  }

  window.location.href = webUrl;
  return true;
};
