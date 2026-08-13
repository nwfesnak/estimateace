/**
 * Build public client payment options from contractor profile.paymentSettings.
 * Processing fees apply to fee-bearing methods (card / PayPal) when
 * chargeFees is true. Venmo, Zelle, and mail check never include a fee.
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
import { computeProcessingFee, methodHasProcessingFee } from '@/lib/stripe-fees';

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
  /** What client should send/pay including fee (if any) */
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
    howItWorks: 'Opens Venmo with the amount and invoice note. Complete payment in Venmo.',
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
    description: 'Bank-to-bank transfer — no processing fee',
    howItWorks:
      'Send the amount shown via your bank’s Zelle. Put the invoice # in the memo. No processing fee.',
    clickToPay: false,
  },
  mailcheck: {
    icon: '✉️',
    label: 'Mail a check',
    description: 'Paper check by mail — no processing fee',
    howItWorks:
      'Mail a check for the amount shown. Write the invoice number on the memo line. No processing fee.',
    clickToPay: false,
  },
};

function roundMoney(n: number) {
  return Math.round(Math.max(0, Number(n) || 0) * 100) / 100;
}

function withFee(
  method: string,
  baseAmount: number,
  opts: { chargeFees: boolean; feePercentOverride?: number }
): Pick<
  ClientPayOption,
  'baseAmount' | 'feeAmount' | 'totalAmount' | 'feeLabel' | 'feeDescription'
> {
  const base = roundMoney(baseAmount);
  // Zelle, mail check, cash — never charge a processing fee
  if (!methodHasProcessingFee(method) || !opts.chargeFees) {
    return {
      baseAmount: base,
      feeAmount: 0,
      totalAmount: base,
      feeLabel: 'No processing fee',
      feeDescription: 'No processing fee for this payment method',
    };
  }
  const fee = computeProcessingFee(base, {
    method,
    chargeFees: true,
    percentRate: opts.feePercentOverride,
  });
  return {
    baseAmount: fee.baseAmount,
    feeAmount: fee.feeAmount,
    totalAmount: fee.totalAmount,
    feeLabel: fee.feeLabel,
    feeDescription: fee.feeDescription,
  };
}

function metaFor(method: string, chargeFees: boolean) {
  const m = META[method];
  if (!m) return m;
  if (!chargeFees || !methodHasProcessingFee(method)) {
    return m;
  }
  // Clarify that fee-bearing methods include a fee when contractor charges it
  if (method === 'stripe') {
    return {
      ...m,
      howItWorks:
        m.howItWorks +
        ' A processing fee is added so the contractor receives the full job amount.',
    };
  }
  if (method === 'paypal') {
    return {
      ...m,
      description: 'PayPal balance, bank, or card (includes processing fee)',
      howItWorks: 'Opens PayPal with amount + fee filled in.',
    };
  }
  return m;
}

/**
 * List enabled payment options for a public client pay page.
 * amount = job amount due now (deposit on estimate, balance on invoice).
 * Fees only when chargeFees is true, and never for Zelle / mail check.
 */
export function buildClientPaymentOptions(input: {
  paymentSettings?: Record<string, PaymentMethodSettings> | null;
  amount: number;
  invoiceNumber: string;
  company?: string;
  label?: string;
  /** Override fee % (e.g. contractor profile ccFeePercentage) */
  feePercentRate?: number;
  /**
   * When true, card/PayPal include processing fee.
   * When false, all methods are base amount only.
   * Venmo never includes a fee.
   */
  chargeFees?: boolean;
}): ClientPayOption[] {
  const settings = mergeSettings(input.paymentSettings);
  const baseAmount = Math.max(0, Number(input.amount) || 0);
  const chargeFees = input.chargeFees === true;
  const feePct = chargeFees ? input.feePercentRate : 0;
  const options: ClientPayOption[] = [];

  if (settings.stripe?.enabled !== false) {
    const m = metaFor('stripe', chargeFees);
    const fee = withFee('stripe', baseAmount, { chargeFees, feePercentOverride: feePct });
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
    const m = metaFor('venmo', false);
    // Venmo never has a processing fee
    const fee = withFee('venmo', baseAmount, { chargeFees: false });
    const note = buildPaymentTrackingNote(
      input.invoiceNumber || '',
      input.label || 'Payment',
      input.company
    );
    options.push({
      method: 'venmo',
      label: m.label,
      icon: m.icon,
      description: 'Pay in the Venmo app — no processing fee',
      howItWorks: 'Opens Venmo with the amount and invoice note. Complete payment in Venmo. No processing fee.',
      ready: true,
      handle: `@${handle}`,
      payUrl: buildVenmoPayUrl(handle, fee.totalAmount, note),
      clickToPay: true,
      ...fee,
    });
  }

  if (settings.paypal?.enabled && hasPayPalSetup(settings.paypal)) {
    const handle = cleanPayPalHandle(settings.paypal.handle || '');
    const m = metaFor('paypal', chargeFees);
    const fee = withFee('paypal', baseAmount, { chargeFees, feePercentOverride: feePct });
    const note = buildPaymentTrackingNote(
      input.invoiceNumber || '',
      fee.feeAmount > 0 ? `${input.label || 'Payment'} + fee` : input.label || 'Payment',
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
    const m = metaFor('zelle', false);
    const fee = withFee('zelle', baseAmount, { chargeFees: false });
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
    const m = metaFor('mailcheck', false);
    const fee = withFee('mailcheck', baseAmount, { chargeFees: false });
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
    const m = metaFor('stripe', chargeFees);
    const fee = withFee('stripe', baseAmount, { chargeFees, feePercentOverride: feePct });
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
