export type PaymentMethodSettings = {
  enabled?: boolean;
  connected?: boolean;
  /** Venmo @username, Zelle email/phone/name, etc. */
  handle?: string;
  /** Storage path or URL for a Zelle QR code image */
  qrUrl?: string;
};

/** Strip @ and spaces from a Venmo username (clients always see @handle). */
export const cleanVenmoHandle = (value: string): string =>
  value
    .trim()
    .replace(/^@+/g, '')
    .replace(/\s+/g, '')
    .replace(/[^a-zA-Z0-9_-]/g, '');

export const hasVenmoHandle = (value?: string): boolean => cleanVenmoHandle(value || '').length > 0;

export const hasVenmoSetup = (settings?: PaymentMethodSettings | null): boolean => {
  if (!settings?.enabled) return false;
  return hasVenmoHandle(settings.handle);
};

export const cleanZelleHandle = (value: string): string => value.trim();

export const hasZelleHandle = (value?: string): boolean => cleanZelleHandle(value || '').length > 0;

export const hasZelleSetup = (settings?: PaymentMethodSettings | null): boolean => {
  if (!settings?.enabled) return false;
  return hasZelleHandle(settings.handle) || !!String(settings.qrUrl || '').trim();
};

/**
 * Shared payment note / memo so the contractor can match client payments
 * to a specific estimate or invoice (Venmo note or Zelle memo).
 * Venmo notes support up to ~280 characters.
 */
export const buildPaymentTrackingNote = (
  invoiceNumber: string,
  label: string,
  company?: string
): string => {
  const parts = [company, invoiceNumber, label]
    .map((p) => String(p || '').trim())
    .filter(Boolean);
  return parts.join(' · ').slice(0, 200);
};

/** @deprecated use buildPaymentTrackingNote */
export const buildZellePaymentMemo = buildPaymentTrackingNote;

/**
 * Official-style Venmo web pay link:
 * https://venmo.com/{username}?txn=pay&amount=10.00&note=Invoice+123
 */
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

/** Deep link for the Venmo mobile app */
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

/**
 * Open Venmo with amount + tracking note pre-filled.
 * Mobile: try app deep link, fall back to web.
 * Desktop: open web pay link in a new tab.
 */
export const openVenmoPaymentPage = (
  handle: string,
  amount: number,
  note: string,
  options?: { newTab?: boolean }
): boolean => {
  const cleaned = cleanVenmoHandle(handle);
  if (!cleaned) return false;

  const webUrl = buildVenmoPayUrl(cleaned, amount, note);
  const appUrl = buildVenmoAppUrl(cleaned, amount, note);
  if (!webUrl) return false;

  const isMobile =
    typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

  if (isMobile && appUrl) {
    // Prefer native app; fall back to web if the app isn't installed
    window.location.href = appUrl;
    window.setTimeout(() => {
      window.location.href = webUrl;
    }, 900);
    return true;
  }

  if (options?.newTab !== false && typeof window !== 'undefined') {
    window.open(webUrl, '_blank', 'noopener,noreferrer');
    return true;
  }

  window.location.href = webUrl;
  return true;
};

// ——— PayPal ———

/** Strip paypal.me/ URL prefixes and @ so we store a clean handle or email. */
export const cleanPayPalHandle = (value: string): string => {
  let v = value.trim();
  v = v.replace(/^https?:\/\//i, '');
  v = v.replace(/^(www\.)?paypal\.me\//i, '');
  v = v.replace(/^paypal\.me\//i, '');
  v = v.replace(/^@+/, '');
  // Drop trailing amount path if someone pastes a full pay link
  v = v.split(/[/?#]/)[0] || '';
  return v.trim();
};

export const hasPayPalHandle = (value?: string): boolean => cleanPayPalHandle(value || '').length > 0;

export const hasPayPalSetup = (settings?: PaymentMethodSettings | null): boolean => {
  if (!settings?.enabled) return false;
  return hasPayPalHandle(settings.handle);
};

export const isPayPalEmail = (handle: string): boolean =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanPayPalHandle(handle));

/**
 * Real PayPal payment URL (not just paypal.com home):
 * - PayPal.Me: https://www.paypal.me/{username}/{amount}USD  (opens pay form for that amount)
 * - Business email: classic _xclick checkout with item_name = tracking note
 */
export const buildPayPalPayUrl = (
  handle: string,
  amount: number,
  note: string,
  currency: string = 'USD'
): string => {
  const cleaned = cleanPayPalHandle(handle);
  if (!cleaned) return '';

  const amt = Math.max(0, amount);
  const amtFixed = amt.toFixed(2);
  const cur = (currency || 'USD').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3) || 'USD';

  if (isPayPalEmail(cleaned)) {
    // Business / email checkout — includes invoice note as item name for tracking
    const params = new URLSearchParams({
      cmd: '_xclick',
      business: cleaned,
      item_name: note.slice(0, 127) || 'Invoice payment',
      amount: amtFixed,
      currency_code: cur,
      no_shipping: '1',
      no_note: '0',
      // Pre-fill buyer note when PayPal shows the form
      cn: 'Invoice / estimate reference',
    });
    return `https://www.paypal.com/cgi-bin/webscr?${params.toString()}`;
  }

  // PayPal.Me username — amount + currency in path (documented PayPal.Me format)
  // Example: https://www.paypal.me/YourBusiness/125.00USD
  return `https://www.paypal.me/${encodeURIComponent(cleaned)}/${amtFixed}${cur}`;
};

export const openPayPalPaymentPage = (
  handle: string,
  amount: number,
  note: string,
  options?: { newTab?: boolean; currency?: string }
): boolean => {
  const url = buildPayPalPayUrl(handle, amount, note, options?.currency);
  if (!url || typeof window === 'undefined') return false;

  if (options?.newTab !== false) {
    window.open(url, '_blank', 'noopener,noreferrer');
    return true;
  }
  window.location.href = url;
  return true;
};
