/**
 * Processing fees passed to the client (payee) for every payment method.
 * Default matches typical US online card rates (2.9% + $0.30).
 * Same fee model is used for Venmo/PayPal/Zelle/mail unless overridden.
 */

export const STRIPE_CARD_PERCENT = 2.9;
export const STRIPE_CARD_FIXED_USD = 0.3;

/** Default % for non-card apps (Venmo, PayPal, Zelle, check) — same as card unless customized */
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
 * Fee schedule per method (can tune later).
 * All methods charge the client a processing fee by default.
 */
export function feeRatesForMethod(method: string): { percentRate: number; fixedFee: number; feeLabel: string } {
  const m = (method || 'stripe').toLowerCase();
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
  if (m === 'venmo') {
    return {
      percentRate: DEFAULT_METHOD_FEE_PERCENT,
      fixedFee: DEFAULT_METHOD_FEE_FIXED,
      feeLabel: 'Venmo processing fee',
    };
  }
  if (m === 'zelle') {
    return {
      percentRate: DEFAULT_METHOD_FEE_PERCENT,
      fixedFee: DEFAULT_METHOD_FEE_FIXED,
      feeLabel: 'Payment processing fee',
    };
  }
  if (m === 'mailcheck' || m === 'check') {
    return {
      percentRate: DEFAULT_METHOD_FEE_PERCENT,
      fixedFee: DEFAULT_METHOD_FEE_FIXED,
      feeLabel: 'Payment processing fee',
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
 * @param options.percentRate override %
 * @param options.fixedFee override fixed $
 */
export function computeProcessingFee(
  baseAmount: number,
  options?: { method?: string; percentRate?: number; fixedFee?: number }
): StripeFeeBreakdown {
  const method = options?.method || 'stripe';
  const rates = feeRatesForMethod(method);
  const base = roundMoney(baseAmount);
  const percentRate =
    options?.percentRate != null && Number.isFinite(options.percentRate)
      ? Math.max(0, Number(options.percentRate))
      : rates.percentRate;
  const fixedFee =
    options?.fixedFee != null && Number.isFinite(options.fixedFee)
      ? Math.max(0, Number(options.fixedFee))
      : rates.fixedFee;

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
  options?: { percentRate?: number; fixedFee?: number }
): StripeFeeBreakdown {
  return computeProcessingFee(baseAmount, {
    method: 'stripe',
    percentRate: options?.percentRate,
    fixedFee: options?.fixedFee,
  });
}

/** Whether to pass fees to the customer (default true). */
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
