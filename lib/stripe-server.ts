import Stripe from 'stripe';

let stripe: Stripe | null = null;
let stripeKeyUsed = '';

export function getStripeSecretKey(): string {
  return (process.env.STRIPE_SECRET_KEY || '').trim();
}

/** test | live | none — based on STRIPE_SECRET_KEY prefix */
export function getStripeMode(): 'test' | 'live' | 'none' {
  const key = getStripeSecretKey();
  if (!key) return 'none';
  if (key.startsWith('sk_live_') || key.startsWith('rk_live_')) return 'live';
  if (key.startsWith('sk_test_') || key.startsWith('rk_test_')) return 'test';
  // Restricted keys / unknown — assume live if not explicitly test
  return key.includes('test') ? 'test' : 'live';
}

export function isStripeLiveMode(): boolean {
  return getStripeMode() === 'live';
}

export function getStripe(): Stripe | null {
  const key = getStripeSecretKey();
  if (!key) return null;
  // Recreate client if key changed (e.g. rotated from test → live without restart edge cases)
  if (!stripe || stripeKeyUsed !== key) {
    stripe = new Stripe(key, { typescript: true });
    stripeKeyUsed = key;
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
