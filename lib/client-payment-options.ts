/**
 * Build public client payment options from contractor profile.paymentSettings.
 * Each option includes base amount + processing fee + total (fee always charged to client).
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
import { computeProcessingFee } from '@/lib/stripe-fees';

export type ClientPayOption = {
  method: string;
  label: string;
  icon: string;
  description: string;
  howItWorks: string;
  ready: boolean;
  handle?: string;
  qrUrl?: string;
  payUrl?: string;
  clickToPay: boolean;
  /** Job amount (deposit or invoice balance) */
  baseAmount: number;
  feeAmount: number;
  /** What client should send/pay including fee */
  totalAmount: number;
  feeLabel: string;
  feeDescription: string;
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
      'Opens Stripe Checkout. Card is always available. Apple Pay / Google Pay appear when your device supports them. US bank eCheck/ACH appears when enabled on the contractor’s Stripe account. Processing fee is added so the contractor receives the job amount.',
    clickToPay: true,
  },
  venmo: {
    icon: '📱',
    label: 'Venmo',
    description: 'Pay in the Venmo app (includes processing fee)',
    howItWorks:
      'Opens Venmo with amount + fee and invoice note. Complete payment in Venmo.',
    clickToPay: true,
  },
  paypal: {
    icon: '💰',
    label: 'PayPal',
    description: 'PayPal balance, bank, or card (includes processing fee)',
    howItWorks: 'Opens PayPal with amount + fee filled in.',
    clickToPay: true,
  },
  zelle: {
    icon: '🏦',
    label: 'Zelle',
    description: 'Bank-to-bank transfer (includes processing fee)',
    howItWorks:
      'Send the total shown (job amount + fee) via your bank’s Zelle. Put the invoice # in the memo.',
    clickToPay: false,
  },
  mailcheck: {
    icon: '✉️',
    label: 'Mail a check',
    description: 'Paper check by mail (includes processing fee)',
    howItWorks:
      'Mail a check for the total shown (job amount + fee). Write the invoice number on the memo line.',
    clickToPay: false,
  },
};

function withFee(
  method: string,
  baseAmount: number,
  feePercentOverride?: number
): Pick<
  ClientPayOption,
  'baseAmount' | 'feeAmount' | 'totalAmount' | 'feeLabel' | 'feeDescription'
> {
  const fee = computeProcessingFee(baseAmount, {
    method,
    percentRate: feePercentOverride,
  });
  return {
    baseAmount: fee.baseAmount,
    feeAmount: fee.feeAmount,
    totalAmount: fee.totalAmount,
    feeLabel: fee.feeLabel,
    feeDescription: fee.feeDescription,
  };
}

/**
 * List enabled payment options for a public client pay page.
 * amount = job amount due now (deposit on estimate, balance on invoice).
 * Every option includes processing fee in totalAmount / payUrl.
 */
export function buildClientPaymentOptions(input: {
  paymentSettings?: Record<string, PaymentMethodSettings> | null;
  amount: number;
  invoiceNumber: string;
  company?: string;
  label?: string;
  /** Override fee % (e.g. contractor profile ccFeePercentage) */
  feePercentRate?: number;
}): ClientPayOption[] {
  const settings = mergeSettings(input.paymentSettings);
  const baseAmount = Math.max(0, Number(input.amount) || 0);
  const feePct = input.feePercentRate;
  const options: ClientPayOption[] = [];

  if (settings.stripe?.enabled !== false) {
    const m = META.stripe;
    const fee = withFee('stripe', baseAmount, feePct);
    const note = buildPaymentTrackingNote(
      input.invoiceNumber || '',
      input.label || 'Payment',
      input.company
    );
    options.push({
      method: 'stripe',
      label: m.label,
      icon: m.icon,
      description: m.description,
      howItWorks: m.howItWorks,
      ready: true,
      clickToPay: true,
      ...fee,
    });
  }

  if (settings.venmo?.enabled && hasVenmoSetup(settings.venmo)) {
    const handle = cleanVenmoHandle(settings.venmo.handle || '');
    const m = META.venmo;
    const fee = withFee('venmo', baseAmount, feePct);
    const note = buildPaymentTrackingNote(
      input.invoiceNumber || '',
      `${input.label || 'Payment'} + fee`,
      input.company
    );
    options.push({
      method: 'venmo',
      label: m.label,
      icon: m.icon,
      description: m.description,
      howItWorks: m.howItWorks,
      ready: true,
      handle: `@${handle}`,
      // Client pays base + fee in Venmo
      payUrl: buildVenmoPayUrl(handle, fee.totalAmount, note),
      clickToPay: true,
      ...fee,
    });
  }

  if (settings.paypal?.enabled && hasPayPalSetup(settings.paypal)) {
    const handle = cleanPayPalHandle(settings.paypal.handle || '');
    const m = META.paypal;
    const fee = withFee('paypal', baseAmount, feePct);
    const note = buildPaymentTrackingNote(
      input.invoiceNumber || '',
      `${input.label || 'Payment'} + fee`,
      input.company
    );
    options.push({
      method: 'paypal',
      label: m.label,
      icon: m.icon,
      description: m.description,
      howItWorks: m.howItWorks,
      ready: true,
      handle,
      payUrl: buildPayPalPayUrl(handle, fee.totalAmount, note),
      clickToPay: true,
      ...fee,
    });
  }

  if (settings.zelle?.enabled && hasZelleSetup(settings.zelle)) {
    const handle = cleanZelleHandle(settings.zelle.handle || '');
    const m = META.zelle;
    const fee = withFee('zelle', baseAmount, feePct);
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
      ...fee,
    });
  }

  if (settings.mailcheck?.enabled && String(settings.mailcheck.handle || '').trim()) {
    const m = META.mailcheck;
    const fee = withFee('mailcheck', baseAmount, feePct);
    options.push({
      method: 'mailcheck',
      label: m.label,
      icon: m.icon,
      description: m.description,
      howItWorks: m.howItWorks,
      ready: true,
      handle: String(settings.mailcheck.handle).trim(),
      clickToPay: false,
      ...fee,
    });
  }

  if (options.length === 0) {
    const m = META.stripe;
    const fee = withFee('stripe', baseAmount, feePct);
    options.push({
      method: 'stripe',
      label: m.label,
      icon: m.icon,
      description: m.description,
      howItWorks: m.howItWorks,
      ready: true,
      clickToPay: true,
      ...fee,
    });
  }

  return options;
}
