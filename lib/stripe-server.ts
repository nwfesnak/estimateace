import Stripe from 'stripe';

let stripe: Stripe | null = null;

export function getStripe(): Stripe | null {
  const key = (process.env.STRIPE_SECRET_KEY || '').trim();
  if (!key) return null;
  if (!stripe) {
    stripe = new Stripe(key, { typescript: true });
  }
  return stripe;
}

export type BillingPlan = 'monthly' | 'yearly';

/** Prefer plan-specific env vars; fall back to legacy STRIPE_PRICE_ID. */
export function getStripePriceId(plan: BillingPlan = 'monthly'): string {
  const monthly =
    (process.env.STRIPE_PRICE_ID_MONTHLY || '').trim() ||
    (process.env.STRIPE_PRICE_ID || '').trim();
  const yearly = (process.env.STRIPE_PRICE_ID_YEARLY || '').trim();
  if (plan === 'yearly') {
    return yearly || monthly;
  }
  return monthly || yearly;
}

export function getStripePriceIds() {
  const monthly =
    (process.env.STRIPE_PRICE_ID_MONTHLY || '').trim() ||
    (process.env.STRIPE_PRICE_ID || '').trim();
  const yearly = (process.env.STRIPE_PRICE_ID_YEARLY || '').trim();
  return {
    monthly: monthly || null,
    yearly: yearly || null,
    hasMonthly: Boolean(monthly),
    hasYearly: Boolean(yearly),
  };
}

export function getAppUrl(requestUrl?: string): string {
  const fromEnv = (process.env.NEXT_PUBLIC_APP_URL || '').trim().replace(/\/$/, '');
  if (fromEnv) return fromEnv;
  if (requestUrl) {
    try {
      const u = new URL(requestUrl);
      return `${u.protocol}//${u.host}`;
    } catch {
      /* ignore */
    }
  }
  return 'http://localhost:3000';
}
