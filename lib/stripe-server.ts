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

export function getStripePriceId(): string {
  return (process.env.STRIPE_PRICE_ID || '').trim();
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
