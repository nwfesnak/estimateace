export type PaymentMethodSettings = {
  enabled?: boolean;
  connected?: boolean;
  /** PayPal.Me username, PayPal email, Zelle name, legacy Venmo @username, etc. */
  handle?: string;
  /** Storage path or URL for a Zelle QR code image */
  qrUrl?: string;
  /**
   * PayPal REST app Client ID (from developer.paypal.com).
   * When set, Smart Payment Buttons can offer PayPal, Venmo, and Pay Later.
   */
  clientId?: string;
};

/** Methods shown as their own rows (Venmo is folded into PayPal). */
export const isStandalonePaymentMethod = (method: string) => method !== 'venmo';

/** Strip @ and spaces from a Venmo username (legacy). */
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
 * to a specific estimate or invoice.
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

// ——— PayPal (includes Venmo + Pay Later when using Client ID / Smart Buttons) ———

export const cleanPayPalHandle = (value: string): string => {
  let v = value.trim();
  v = v.replace(/^https?:\/\//i, '');
  v = v.replace(/^(www\.)?paypal\.me\//i, '');
  v = v.replace(/^paypal\.me\//i, '');
  v = v.replace(/^@+/, '');
  v = v.split(/[/?#]/)[0] || '';
  return v.trim();
};

export const cleanPayPalClientId = (value: string): string =>
  value.trim().replace(/\s+/g, '');

export const hasPayPalHandle = (value?: string): boolean => cleanPayPalHandle(value || '').length > 0;

export const hasPayPalClientId = (value?: string): boolean => cleanPayPalClientId(value || '').length > 10;

/** Ready if PayPal.Me/email and/or Client ID is set (and enabled). */
export const hasPayPalSetup = (settings?: PaymentMethodSettings | null): boolean => {
  if (!settings?.enabled) return false;
  return hasPayPalHandle(settings.handle) || hasPayPalClientId(settings.clientId);
};

/** Smart Buttons can offer PayPal + Venmo + Pay Later when Client ID is present. */
export const hasPayPalSmartCheckout = (settings?: PaymentMethodSettings | null): boolean => {
  if (!settings?.enabled) return false;
  return hasPayPalClientId(settings.clientId);
};

export const isPayPalEmail = (handle: string): boolean =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanPayPalHandle(handle));

/**
 * Fallback payment URL when Smart Buttons are not configured:
 * - PayPal.Me amount link
 * - Business email _xclick with invoice as item name
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
    const params = new URLSearchParams({
      cmd: '_xclick',
      business: cleaned,
      item_name: note.slice(0, 127) || 'Invoice payment',
      amount: amtFixed,
      currency_code: cur,
      no_shipping: '1',
      no_note: '0',
      cn: 'Invoice / estimate reference',
    });
    return `https://www.paypal.com/cgi-bin/webscr?${params.toString()}`;
  }

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

/** PayPal merchant account setup (enable Venmo / Pay Later in the dashboard). */
export const PAYPAL_BUSINESS_SETUP_URL = 'https://www.paypal.com/businessmanage/account/aboutBusiness';
export const PAYPAL_DEVELOPER_APPS_URL = 'https://developer.paypal.com/dashboard/applications/live';
export const PAYPAL_ME_CREATE_URL = 'https://www.paypal.com/paypalme/';

type PayPalNamespace = {
  Buttons: (config: Record<string, unknown>) => { render: (selector: string | HTMLElement) => Promise<void> };
};

declare global {
  interface Window {
    paypal?: PayPalNamespace;
  }
}

/** Load PayPal JS SDK with Venmo + Pay Later funding enabled. */
export function loadPayPalSdk(clientId: string, currency: string = 'USD'): Promise<PayPalNamespace> {
  const id = cleanPayPalClientId(clientId);
  if (!id) return Promise.reject(new Error('Missing PayPal Client ID'));

  if (typeof window !== 'undefined' && window.paypal?.Buttons) {
    return Promise.resolve(window.paypal);
  }

  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-estimateace-paypal-sdk]');
    if (existing) {
      existing.addEventListener('load', () => {
        if (window.paypal) resolve(window.paypal);
        else reject(new Error('PayPal SDK failed to load'));
      });
      existing.addEventListener('error', () => reject(new Error('PayPal SDK failed to load')));
      return;
    }

    const params = new URLSearchParams({
      'client-id': id,
      currency: currency || 'USD',
      intent: 'capture',
      components: 'buttons,funding-eligibility',
      'enable-funding': 'venmo,paylater',
      'disable-funding': 'card',
    });

    const script = document.createElement('script');
    script.src = `https://www.paypal.com/sdk/js?${params.toString()}`;
    script.async = true;
    script.dataset.estimateacePaypalSdk = '1';
    script.onload = () => {
      if (window.paypal?.Buttons) resolve(window.paypal);
      else reject(new Error('PayPal SDK loaded without Buttons'));
    };
    script.onerror = () => reject(new Error('PayPal SDK network error'));
    document.body.appendChild(script);
  });
}
