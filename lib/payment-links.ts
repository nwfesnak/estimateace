export type PaymentMethodSettings = {
  enabled?: boolean;
  connected?: boolean;
  handle?: string;
};

export const cleanVenmoHandle = (value: string): string => value.trim().replace(/^@+/, '').trim();

export const hasVenmoHandle = (value?: string): boolean => cleanVenmoHandle(value || '').length > 0;

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