/**
 * Build public client payment options from contractor profile.paymentSettings.
 * Used on emailed pay links (/client/approve) so clients see every enabled method —
 * not only Stripe card.
 */
import {
  buildPayPalPayUrl,
  buildPaymentTrackingNote,
  buildVenmoPayUrl,
  cleanPayPalHandle,
  cleanVenmoHandle,
  cleanZelleHandle,
  hasPayPalSetup,
  hasVenmoSetup,
  hasZelleSetup,
  type PaymentMethodSettings,
} from '@/lib/payment-links';

export type ClientPayOption = {
  method: string;
  label: string;
  icon: string;
  description: string;
  howItWorks: string;
  /** Ready for client to use */
  ready: boolean;
  handle?: string;
  qrUrl?: string;
  /** Prebuilt pay URL when applicable */
  payUrl?: string;
  clickToPay: boolean;
};

const DEFAULTS: Record<string, PaymentMethodSettings> = {
  venmo: { enabled: false, connected: false, handle: '' },
  paypal: { enabled: false, connected: false, handle: '' },
  zelle: { enabled: false, connected: false, handle: '', qrUrl: '' },
  stripe: { enabled: true, connected: false },
  mailcheck: { enabled: false, connected: false, handle: '' },
  nowpayments: { enabled: false, connected: false, handle: '' },
  coinbase_commerce: { enabled: false, connected: false, handle: '' },
};

function mergeSettings(
  settings?: Record<string, PaymentMethodSettings> | null
): Record<string, PaymentMethodSettings> {
  const out: Record<string, PaymentMethodSettings> = {};
  for (const [k, d] of Object.entries(DEFAULTS)) {
    out[k] = { ...d, ...(settings?.[k] || {}) };
  }
  return out;
}

const META: Record<
  string,
  { icon: string; label: string; description: string; howItWorks: string; clickToPay: boolean }
> = {
  stripe: {
    icon: '💳',
    label: 'Card · Apple Pay · eCheck / ACH',
    description: 'Pay securely with Stripe Checkout',
    howItWorks:
      'Opens Stripe Checkout. Card is always available. Apple Pay / Google Pay appear when your device supports them. US bank eCheck/ACH appears when enabled on the contractor’s Stripe account.',
    clickToPay: true,
  },
  venmo: {
    icon: '📱',
    label: 'Venmo',
    description: 'Pay in the Venmo app',
    howItWorks: 'Opens Venmo with amount and invoice note. Complete payment in Venmo.',
    clickToPay: true,
  },
  paypal: {
    icon: '💰',
    label: 'PayPal',
    description: 'PayPal balance, bank, or card',
    howItWorks: 'Opens PayPal with the amount filled in.',
    clickToPay: true,
  },
  zelle: {
    icon: '🏦',
    label: 'Zelle',
    description: 'Bank-to-bank transfer',
    howItWorks: 'Send the exact amount via your bank’s Zelle to the details shown. Put the invoice # in the memo.',
    clickToPay: false,
  },
  mailcheck: {
    icon: '✉️',
    label: 'Mail a check',
    description: 'Paper check by mail',
    howItWorks: 'Mail a check for the amount due. Write the invoice number on the memo line.',
    clickToPay: false,
  },
};

/**
 * List enabled payment options for a public client pay page.
 * amount = dollars the client owes for this payment (deposit/balance).
 */
export function buildClientPaymentOptions(input: {
  paymentSettings?: Record<string, PaymentMethodSettings> | null;
  amount: number;
  invoiceNumber: string;
  company?: string;
  label?: string;
}): ClientPayOption[] {
  const settings = mergeSettings(input.paymentSettings);
  const amount = Math.max(0, Number(input.amount) || 0);
  const note = buildPaymentTrackingNote(
    input.invoiceNumber || '',
    input.label || 'Payment',
    input.company
  );
  const options: ClientPayOption[] = [];

  // Stripe first when enabled (card / Apple Pay / ACH inside Checkout)
  if (settings.stripe?.enabled !== false) {
    const m = META.stripe;
    options.push({
      method: 'stripe',
      label: m.label,
      icon: m.icon,
      description: m.description,
      howItWorks: m.howItWorks,
      ready: true,
      clickToPay: true,
    });
  }

  if (settings.venmo?.enabled && hasVenmoSetup(settings.venmo)) {
    const handle = cleanVenmoHandle(settings.venmo.handle || '');
    const m = META.venmo;
    options.push({
      method: 'venmo',
      label: m.label,
      icon: m.icon,
      description: m.description,
      howItWorks: m.howItWorks,
      ready: true,
      handle: `@${handle}`,
      payUrl: buildVenmoPayUrl(handle, amount, note),
      clickToPay: true,
    });
  }

  if (settings.paypal?.enabled && hasPayPalSetup(settings.paypal)) {
    const handle = cleanPayPalHandle(settings.paypal.handle || '');
    const m = META.paypal;
    options.push({
      method: 'paypal',
      label: m.label,
      icon: m.icon,
      description: m.description,
      howItWorks: m.howItWorks,
      ready: true,
      handle,
      payUrl: buildPayPalPayUrl(handle, amount, note),
      clickToPay: true,
    });
  }

  if (settings.zelle?.enabled && hasZelleSetup(settings.zelle)) {
    const handle = cleanZelleHandle(settings.zelle.handle || '');
    const m = META.zelle;
    options.push({
      method: 'zelle',
      label: m.label,
      icon: m.icon,
      description: m.description,
      howItWorks: m.howItWorks,
      ready: true,
      handle: handle || undefined,
      qrUrl: settings.zelle.qrUrl || undefined,
      clickToPay: false,
    });
  }

  if (settings.mailcheck?.enabled && String(settings.mailcheck.handle || '').trim()) {
    const m = META.mailcheck;
    options.push({
      method: 'mailcheck',
      label: m.label,
      icon: m.icon,
      description: m.description,
      howItWorks: m.howItWorks,
      ready: true,
      handle: String(settings.mailcheck.handle).trim(),
      clickToPay: false,
    });
  }

  // Always offer Stripe if nothing else ready (so client can still pay)
  if (options.length === 0) {
    const m = META.stripe;
    options.push({
      method: 'stripe',
      label: m.label,
      icon: m.icon,
      description: m.description,
      howItWorks: m.howItWorks,
      ready: true,
      clickToPay: true,
    });
  }

  return options;
}
