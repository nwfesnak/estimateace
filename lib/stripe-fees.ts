/**
 * Processing fees passed to the client (payee) only when the contractor
 * enables "charge processing fee" — and only for methods that have fees.
 *
 * No fee methods: Zelle, mail a check, cash (free bank/mail transfer).
 * Fee methods (when enabled): Card/Stripe, Venmo, PayPal (default 2.9% + $0.30).
 */

export const STRIPE_CARD_PERCENT = 2.9;
export const STRIPE_CARD_FIXED_USD = 0.3;

/** Default % for fee-bearing apps (Venmo, PayPal) — same as card unless customized */
export const DEFAULT_METHOD_FEE_PERCENT = 2.9;
export const DEFAULT_METHOD_FEE_FIXED = 0.3;

export type StripeFeeBreakdown = {
  baseAmount: number;
  percentRate: number;
  fixedFee: number;
  feeAmount: number;
  totalAmount: number;
  feeLabel: string;
  feeDescription: string;
  method: string;
};

function roundMoney(n: number) {
  return Math.round(Math.max(0, n) * 100) / 100;
}

/**
 * Methods that can include a processing fee when chargeCCFee is on.
 * Venmo, Zelle, mail check, cash: never charged a processing fee.
 */
export function methodHasProcessingFee(method: string): boolean {
  const m = (method || '').toLowerCase().replace(/[\s-]+/g, '_');
  if (
    m === 'zelle' ||
    m === 'venmo' ||
    m === 'mailcheck' ||
    m === 'mail_check' ||
    m === 'check' ||
    m === 'cash' ||
    m === 'money_order'
  ) {
    return false;
  }
  // Stripe card / PayPal (and similar) only
  if (
    m === 'stripe' ||
    m === 'card' ||
    m === 'apple_pay' ||
    m === 'ach' ||
    m === 'us_bank_account' ||
    m === 'paypal'
  ) {
    return true;
  }
  return false;
}

/**
 * Fee schedule per method.
 * Venmo / Zelle / mail check / cash: always $0.
 * Card / PayPal: rates apply only when contractor enables chargeCCFee.
 */
export function feeRatesForMethod(method: string): { percentRate: number; fixedFee: number; feeLabel: string } {
  const m = (method || 'stripe').toLowerCase();
  if (!methodHasProcessingFee(m)) {
    return {
      percentRate: 0,
      fixedFee: 0,
      feeLabel: 'No processing fee',
    };
  }
  if (m === 'stripe' || m === 'card' || m === 'apple_pay' || m === 'ach' || m === 'us_bank_account') {
    return {
      percentRate: STRIPE_CARD_PERCENT,
      fixedFee: STRIPE_CARD_FIXED_USD,
      feeLabel: 'Card / Stripe processing fee',
    };
  }
  if (m === 'paypal') {
    return {
      percentRate: DEFAULT_METHOD_FEE_PERCENT,
      fixedFee: DEFAULT_METHOD_FEE_FIXED,
      feeLabel: 'PayPal processing fee',
    };
  }
  return {
    percentRate: DEFAULT_METHOD_FEE_PERCENT,
    fixedFee: DEFAULT_METHOD_FEE_FIXED,
    feeLabel: 'Payment processing fee',
  };
}

/**
 * Compute processing fee on a base charge (job amount due).
 * @param baseAmount dollars owed for the job portion
 * @param options.method payment method key
 * @param options.percentRate override % (0 disables %)
 * @param options.fixedFee override fixed $ (0 disables fixed)
 * @param options.chargeFees when false, fee is always $0 (contractor absorbs fees)
 */
export function computeProcessingFee(
  baseAmount: number,
  options?: {
    method?: string;
    percentRate?: number;
    fixedFee?: number;
    /** If false, never add a fee (company does not charge processing fees). Default true for backward compat when method has rates. */
    chargeFees?: boolean;
  }
): StripeFeeBreakdown {
  const method = options?.method || 'stripe';
  const rates = feeRatesForMethod(method);
  const base = roundMoney(baseAmount);

  // Company opted out, or method is free (Zelle / mail check)
  if (options?.chargeFees === false || !methodHasProcessingFee(method)) {
    return {
      baseAmount: base,
      percentRate: 0,
      fixedFee: 0,
      feeAmount: 0,
      totalAmount: base,
      feeLabel: 'No processing fee',
      feeDescription: 'No processing fee for this payment method',
      method,
    };
  }

  const percentRate =
    options?.percentRate != null && Number.isFinite(options.percentRate)
      ? Math.max(0, Number(options.percentRate))
      : rates.percentRate;
  const fixedFee =
    options?.fixedFee != null && Number.isFinite(options.fixedFee)
      ? Math.max(0, Number(options.fixedFee))
      : rates.fixedFee;

  // Both zero → no fee line
  if (percentRate <= 0 && fixedFee <= 0) {
    return {
      baseAmount: base,
      percentRate: 0,
      fixedFee: 0,
      feeAmount: 0,
      totalAmount: base,
      feeLabel: 'No processing fee',
      feeDescription: 'No processing fee for this payment method',
      method,
    };
  }

  const feeAmount = roundMoney(base * (percentRate / 100) + fixedFee);
  const totalAmount = roundMoney(base + feeAmount);

  const feeDescription =
    percentRate > 0 && fixedFee > 0
      ? `${rates.feeLabel} (${percentRate}% + $${fixedFee.toFixed(2)}) so the contractor receives the job amount`
      : percentRate > 0
        ? `${rates.feeLabel} (${percentRate}%)`
        : `${rates.feeLabel} ($${fixedFee.toFixed(2)})`;

  return {
    baseAmount: base,
    percentRate,
    fixedFee,
    feeAmount,
    totalAmount,
    feeLabel: rates.feeLabel,
    feeDescription,
    method,
  };
}

/** @deprecated use computeProcessingFee — kept for existing imports */
export function computeStripeCardFee(
  baseAmount: number,
  options?: {
    percentRate?: number;
    fixedFee?: number;
    chargeFees?: boolean;
    method?: string;
  }
): StripeFeeBreakdown {
  return computeProcessingFee(baseAmount, {
    method: options?.method || 'stripe',
    percentRate: options?.percentRate,
    fixedFee: options?.fixedFee,
    chargeFees: options?.chargeFees,
  });
}

/** Whether env allows passing fees to the customer (default true). Company setting still required. */
export function shouldPassProcessingFeeToPayee(): boolean {
  const v = String(process.env.STRIPE_PASS_FEES_TO_CUSTOMER || 'true').toLowerCase();
  return v !== 'false' && v !== '0' && v !== 'no';
}

/**
 * Amount the client should pay on this document:
 * - estimate → deposit (if enabled)
 * - invoice → full balance (grandTotal − amountPaid)
 */
export function resolveAmountDue(input: {
  documentType: string;
  grandTotal: number;
  amountPaid?: number;
  depositPercent?: number;
  showDepositOnApproval?: boolean;
}): {
  documentType: 'estimate' | 'invoice';
  grandTotal: number;
  amountPaid: number;
  depositPercent: number;
  depositDue: number;
  balanceDue: number;
  /** What the client is asked to pay now (before processing fee) */
  amountDueNow: number;
  payKind: 'deposit' | 'balance';
  payLabel: string;
} {
  const documentType =
    String(input.documentType || '').toLowerCase() === 'invoice' ? 'invoice' : 'estimate';
  const grandTotal = roundMoney(Number(input.grandTotal) || 0);
  const amountPaid = roundMoney(Number(input.amountPaid) || 0);
  const depositPercent = Math.max(0, Number(input.depositPercent) || 0);
  const showDeposit =
    documentType === 'estimate' &&
    input.showDepositOnApproval !== false &&
    depositPercent > 0;
  const depositDue = showDeposit
    ? roundMoney((grandTotal * depositPercent) / 100)
    : 0;
  // Final invoice = full job − deposits already paid
  const balanceDue = roundMoney(Math.max(0, grandTotal - amountPaid));

  if (documentType === 'estimate') {
    const amountDueNow = depositDue >= 0.5 ? depositDue : balanceDue;
    return {
      documentType,
      grandTotal,
      amountPaid,
      depositPercent,
      depositDue,
      balanceDue,
      amountDueNow,
      payKind: depositDue >= 0.5 ? 'deposit' : 'balance',
      payLabel: depositDue >= 0.5 ? 'Deposit due' : 'Amount due',
    };
  }

  return {
    documentType: 'invoice',
    grandTotal,
    amountPaid,
    depositPercent,
    depositDue: 0,
    balanceDue,
    amountDueNow: balanceDue,
    payKind: 'balance',
    payLabel: amountPaid > 0 ? 'Balance due (after deposit)' : 'Total due',
  };
}
