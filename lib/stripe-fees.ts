/**
 * Stripe processing fee estimates for US cards (standard online rate).
 * Used so the payee sees a clear fee line on Checkout — not hidden in the base price.
 *
 * Default US Stripe card: 2.9% + $0.30 per successful charge.
 * ACH is lower; we quote card fee when Checkout offers card (most common).
 */

export const STRIPE_CARD_PERCENT = 2.9;
export const STRIPE_CARD_FIXED_USD = 0.3;

export type StripeFeeBreakdown = {
  baseAmount: number;
  /** Percentage rate used (e.g. 2.9) */
  percentRate: number;
  fixedFee: number;
  /** Fee charged to the payee */
  feeAmount: number;
  /** base + fee */
  totalAmount: number;
  /** Human labels for Checkout / UI */
  feeLabel: string;
  feeDescription: string;
};

function roundMoney(n: number) {
  return Math.round(Math.max(0, n) * 100) / 100;
}

/**
 * Compute card processing fee on a base charge.
 * @param baseAmount dollars the contractor is owed (deposit/balance/invoice)
 * @param options.percentRate override (e.g. contractor profile 3%)
 * @param options.fixedFee override fixed portion (default $0.30)
 */
export function computeStripeCardFee(
  baseAmount: number,
  options?: { percentRate?: number; fixedFee?: number }
): StripeFeeBreakdown {
  const base = roundMoney(baseAmount);
  const percentRate =
    options?.percentRate != null && Number.isFinite(options.percentRate)
      ? Math.max(0, Number(options.percentRate))
      : STRIPE_CARD_PERCENT;
  const fixedFee =
    options?.fixedFee != null && Number.isFinite(options.fixedFee)
      ? Math.max(0, Number(options.fixedFee))
      : STRIPE_CARD_FIXED_USD;

  const feeAmount = roundMoney(base * (percentRate / 100) + fixedFee);
  const totalAmount = roundMoney(base + feeAmount);

  const feeLabel = 'Card processing fee';
  const feeDescription =
    percentRate > 0 && fixedFee > 0
      ? `Stripe card fee (${percentRate}% + $${fixedFee.toFixed(2)}) so the contractor receives the job amount`
      : percentRate > 0
        ? `Card processing (${percentRate}%)`
        : `Card processing ($${fixedFee.toFixed(2)})`;

  return {
    baseAmount: base,
    percentRate,
    fixedFee,
    feeAmount,
    totalAmount,
    feeLabel,
    feeDescription,
  };
}

/** Whether to add fee as a separate Checkout line (always for card job payments). */
export function shouldPassProcessingFeeToPayee(): boolean {
  const v = String(process.env.STRIPE_PASS_FEES_TO_CUSTOMER || 'true').toLowerCase();
  return v !== 'false' && v !== '0' && v !== 'no';
}
