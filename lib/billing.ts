/**
 * EstimateAce SaaS billing (Phase A) — subscription for access to the product.
 * When Stripe is not configured or NEXT_PUBLIC_BILLING_ENFORCE is not "true",
 * all authenticated users keep full access (dev / soft launch) UNLESS account
 * was scheduled for deletion and the close date has passed.
 */

export type SubscriptionStatus =
  | 'none'
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'unpaid'
  | 'incomplete'
  | 'incomplete_expired'
  | 'paused';

export type BillingSnapshot = {
  status: SubscriptionStatus;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  priceId: string | null;
  currentPeriodEnd: string | null;
  trialEndsAt: string | null;
  cancelAtPeriodEnd: boolean;
  /** When set, account is closing; access until this date, then blocked + data purge */
  accountClosesAt: string | null;
  deletionRequestedAt: string | null;
};

export const DEFAULT_TRIAL_DAYS = 14;

/** Grace after a Stripe-managed trial ends while we wait for the subscription webhook. */
export const TRIAL_WEBHOOK_GRACE_MS = 2 * 24 * 60 * 60 * 1000;

export const DEFAULT_BILLING_SNAPSHOT: BillingSnapshot = {
  status: 'none',
  stripeCustomerId: null,
  stripeSubscriptionId: null,
  priceId: null,
  currentPeriodEnd: null,
  trialEndsAt: null,
  cancelAtPeriodEnd: false,
  accountClosesAt: null,
  deletionRequestedAt: null,
};

/**
 * Client + server: only enforce paywall when explicitly enabled.
 * Soft launch: leave NEXT_PUBLIC_BILLING_ENFORCE unset/false so logins are not blocked.
 * Set NEXT_PUBLIC_BILLING_ENFORCE=true in Vercel when ready to hard-paywall.
 */
export function isBillingEnforced(): boolean {
  return String(process.env.NEXT_PUBLIC_BILLING_ENFORCE || '').toLowerCase() === 'true';
}

export function isStripeConfigured(): boolean {
  const hasSecret = Boolean((process.env.STRIPE_SECRET_KEY || '').trim());
  const hasMonthly = Boolean(
    (process.env.STRIPE_PRICE_ID_MONTHLY || process.env.STRIPE_PRICE_ID || '').trim()
  );
  const hasYearly = Boolean((process.env.STRIPE_PRICE_ID_YEARLY || '').trim());
  return hasSecret && (hasMonthly || hasYearly);
}

/** Server diagnostics for Profile billing UI */
export function getStripeConfigDiagnostics() {
  const key = (process.env.STRIPE_SECRET_KEY || '').trim();
  const hasSecretKey = Boolean(key);
  const mode = key.startsWith('sk_live_') || key.startsWith('rk_live_')
    ? ('live' as const)
    : key.startsWith('sk_test_') || key.startsWith('rk_test_')
      ? ('test' as const)
      : key
        ? ('unknown' as const)
        : ('none' as const);
  const hasPriceIdMonthly = Boolean(
    (process.env.STRIPE_PRICE_ID_MONTHLY || process.env.STRIPE_PRICE_ID || '').trim()
  );
  const hasPriceIdYearly = Boolean((process.env.STRIPE_PRICE_ID_YEARLY || '').trim());
  const hasPriceId = hasPriceIdMonthly || hasPriceIdYearly;
  const hasWebhookSecret = Boolean((process.env.STRIPE_WEBHOOK_SECRET || '').trim());
  const hasServiceRole = Boolean((process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim());
  return {
    hasSecretKey,
    mode,
    isLive: mode === 'live',
    isTest: mode === 'test',
    hasPriceId,
    hasPriceIdMonthly,
    hasPriceIdYearly,
    hasWebhookSecret,
    hasServiceRole,
    configured: hasSecretKey && hasPriceId,
  };
}

export function getTrialDays(): number {
  const n = Number(process.env.NEXT_PUBLIC_TRIAL_DAYS || DEFAULT_TRIAL_DAYS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_TRIAL_DAYS;
}

/**
 * Approved trial offers. Anything else is rejected server-side so nobody can
 * hand themselves an arbitrary trial length by editing the request.
 *  - standard: NEXT_PUBLIC_TRIAL_DAYS (default 14)
 *  - 2mo: estimateace.com/2-months-free.html  (?promo=2mo)  → 60 days
 *  - 6mo: estimateace.com/6-months-free.html  (?promo=6mo)  → 180 days
 *  - 3mo: legacy capped offer (first 20 signups) → 90 days
 * Standard and 2mo require a card up front (Stripe Checkout trial). 6mo and 3mo are
 * card-free but capped at 20 signups each (see claim_promo_spot in Postgres).
 */
export const TRIAL_OFFERS = {
  standard: () => getTrialDays(),
  '2mo': () => 60,
  '3mo': () => 90,
  '6mo': () => 180,
} as const;

export type TrialOffer = keyof typeof TRIAL_OFFERS;

export function normalizePromo(promo?: string | null): TrialOffer | null {
  const p = String(promo || '')
    .trim()
    .toLowerCase();
  if (!p) return null;
  if (p === '3mo' || p === '3months' || p === '90' || p === 'three-months') return '3mo';
  if (p === '2mo' || p === '2months' || p === '60' || p === 'two-months') return '2mo';
  if (p === '6mo' || p === '6months' || p === '180' || p === 'six-months') return '6mo';
  return null;
}

/** Every trial length (in days) the server will accept. */
export function allowedTrialDays(): number[] {
  return Array.from(new Set(Object.values(TRIAL_OFFERS).map((f) => f())));
}

export function isAllowedTrialDays(days: unknown): boolean {
  const n = Number(days);
  return Number.isFinite(n) && allowedTrialDays().includes(Math.floor(n));
}

/**
 * Promo codes from marketing landers (e.g. ?promo=2mo → 60 days).
 * Unknown promos and arbitrary client-sent day counts fall back to the standard trial.
 */
export function resolveTrialDaysFromPromo(promo?: string | null): number {
  const offer = normalizePromo(promo);
  if (offer) return TRIAL_OFFERS[offer]();
  return getTrialDays();
}

/** 3-month lander (?promo=3mo). Card is not collected at signup. */
export function isThreeMonthPromo(promo?: string | null): boolean {
  const p = String(promo || '')
    .trim()
    .toLowerCase();
  return p === '3mo' || p === '3months' || p === '90' || p === 'three-months';
}

export const THREE_MONTH_PROMO_DAYS = 90;
export const THREE_MONTH_PROMO_LIMIT = 20;

/** 6-month lander (?promo=6mo). Card-free, capped at the first 20 signups. */
export const SIX_MONTH_PROMO_DAYS = 180;
export const SIX_MONTH_PROMO_LIMIT = 20;

/**
 * Offers that start WITHOUT a card. Both are capped (20 signups each) and claimed
 * atomically in Postgres (claim_promo_spot). Every other offer (standard 14-day,
 * 2-month) requires a card up front through Stripe Checkout.
 */
export type CardFreeOffer = '6mo' | '3mo';
export const CARD_FREE_OFFER_LIMITS: Record<CardFreeOffer, number> = {
  '6mo': SIX_MONTH_PROMO_LIMIT,
  '3mo': THREE_MONTH_PROMO_LIMIT,
};

export function cardFreeOffer(promo?: string | null): CardFreeOffer | null {
  const offer = normalizePromo(promo);
  return offer === '6mo' || offer === '3mo' ? offer : null;
}

/** True for the standard and 2-month offers: a card is collected before any access. */
export function offerRequiresCard(promo?: string | null): boolean {
  return cardFreeOffer(promo) === null;
}

/**
 * Trial length for a card-required offer, used by Stripe Checkout. A capped
 * card-free promo that was full falls back to the standard trial.
 */
export function cardTrialDaysForPromo(promo?: string | null): number {
  const offer = normalizePromo(promo);
  if (offer === '2mo') return TRIAL_OFFERS['2mo']();
  return TRIAL_OFFERS.standard();
}

/**
 * A brand-new account that has never had a trial or Stripe subscription can start
 * its card-required trial in Checkout. Anyone who already had a trial (app-managed
 * or Stripe) only keeps whatever is left of it, so re-subscribing never resets it.
 */
export function isEligibleForCardTrial(row: {
  status?: string | null;
  trial_ends_at?: string | null;
  stripe_subscription_id?: string | null;
} | null | undefined): boolean {
  if (!row) return true;
  const status = String(row.status || 'none');
  return status === 'none' && !row.trial_ends_at && !row.stripe_subscription_id;
}

export function normalizeBillingSnapshot(raw: unknown): BillingSnapshot {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const status = String(r.status || 'none') as SubscriptionStatus;
  const allowed: SubscriptionStatus[] = [
    'none',
    'trialing',
    'active',
    'past_due',
    'canceled',
    'unpaid',
    'incomplete',
    'incomplete_expired',
    'paused',
  ];
  return {
    status: allowed.includes(status) ? status : 'none',
    stripeCustomerId: r.stripeCustomerId ? String(r.stripeCustomerId) : null,
    stripeSubscriptionId: r.stripeSubscriptionId ? String(r.stripeSubscriptionId) : null,
    priceId: r.priceId ? String(r.priceId) : null,
    currentPeriodEnd: r.currentPeriodEnd ? String(r.currentPeriodEnd) : null,
    trialEndsAt: r.trialEndsAt ? String(r.trialEndsAt) : null,
    cancelAtPeriodEnd: r.cancelAtPeriodEnd === true,
    accountClosesAt: r.accountClosesAt ? String(r.accountClosesAt) : null,
    deletionRequestedAt: r.deletionRequestedAt ? String(r.deletionRequestedAt) : null,
  };
}

/** Start a free trial clock from first login/signup if none set. */
export function ensureTrialEndsAt(
  snapshot: BillingSnapshot,
  now = new Date(),
  trialDaysOverride?: number
): BillingSnapshot {
  // Status stuck as "none" but trial date still in the future → show trialing
  if (snapshot.trialEndsAt) {
    const end = new Date(snapshot.trialEndsAt).getTime();
    if (
      !isNaN(end) &&
      end > now.getTime() &&
      (snapshot.status === 'none' || !snapshot.status)
    ) {
      return { ...snapshot, status: 'trialing' };
    }
    return snapshot;
  }
  if (snapshot.status === 'active' || snapshot.status === 'trialing') return snapshot;
  // Don't start a new trial if account is scheduled to close or already canceled period
  if (snapshot.accountClosesAt) return snapshot;
  const days =
    trialDaysOverride != null && isAllowedTrialDays(trialDaysOverride)
      ? Math.floor(trialDaysOverride)
      : getTrialDays();
  const end = new Date(now);
  end.setDate(end.getDate() + days);
  return {
    ...snapshot,
    status: snapshot.status === 'none' ? 'trialing' : snapshot.status,
    trialEndsAt: end.toISOString(),
  };
}

/** Account scheduled to close and the close date has passed. */
export function isAccountClosed(snapshot: BillingSnapshot, now = new Date()): boolean {
  if (!snapshot.accountClosesAt) return false;
  const t = new Date(snapshot.accountClosesAt).getTime();
  return !isNaN(t) && t <= now.getTime();
}

/** Still has access after delete request until close date. */
export function isAccountClosing(snapshot: BillingSnapshot, now = new Date()): boolean {
  if (!snapshot.accountClosesAt) return false;
  const t = new Date(snapshot.accountClosesAt).getTime();
  return !isNaN(t) && t > now.getTime();
}

/**
 * Pick end of paid access for scheduled deletion:
 * period end > trial end > end of today (UTC day) if free/none.
 */
export function resolveAccountCloseDate(snapshot: BillingSnapshot, now = new Date()): Date {
  const candidates: number[] = [];
  if (snapshot.currentPeriodEnd) {
    const t = new Date(snapshot.currentPeriodEnd).getTime();
    if (!isNaN(t)) candidates.push(t);
  }
  if (snapshot.trialEndsAt) {
    const t = new Date(snapshot.trialEndsAt).getTime();
    if (!isNaN(t)) candidates.push(t);
  }
  const future = candidates.filter((t) => t > now.getTime());
  if (future.length) {
    return new Date(Math.max(...future));
  }
  if (candidates.length) {
    // Period already ended — close end of today
    const end = new Date(now);
    end.setHours(23, 59, 59, 999);
    return end;
  }
  // No paid period: grant rest of calendar day then close
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  return end;
}

export function hasAppAccess(snapshot: BillingSnapshot, now = new Date()): boolean {
  // Scheduled deletion past close date always blocks (even if billing not enforced)
  if (isAccountClosed(snapshot, now)) return false;

  if (!isBillingEnforced()) return true;

  const status = snapshot.status;
  if (status === 'active') return true;
  if (status === 'past_due') return false;

  const trialEnd = snapshot.trialEndsAt ? new Date(snapshot.trialEndsAt).getTime() : NaN;
  const trialStillRunning = !isNaN(trialEnd) && trialEnd > now.getTime();

  if (status === 'trialing') {
    // App-managed trial (no Stripe subscription yet): access only until trial end.
    if (trialStillRunning) return true;
    // Stripe-managed trial (they subscribed mid-trial, card on file). Stripe converts it
    // to active/past_due at trial end; allow a short grace for webhook lag.
    if (snapshot.stripeSubscriptionId) {
      if (isNaN(trialEnd)) return true;
      return trialEnd + TRIAL_WEBHOOK_GRACE_MS > now.getTime();
    }
    return false;
  }

  if (trialStillRunning) return true;

  // Canceled / closing but still inside paid period
  if (snapshot.currentPeriodEnd) {
    const end = new Date(snapshot.currentPeriodEnd).getTime();
    if (!isNaN(end) && end > now.getTime()) {
      if (status === 'canceled' || snapshot.cancelAtPeriodEnd || snapshot.accountClosesAt) {
        return true;
      }
    }
  }

  if (isAccountClosing(snapshot, now)) return true;

  return false;
}

export function accessBlockedReason(snapshot: BillingSnapshot, now = new Date()): string | null {
  if (hasAppAccess(snapshot, now)) return null;
  if (isAccountClosed(snapshot, now)) {
    return `Your account closed on ${formatPeriodEnd(snapshot.accountClosesAt)}. Contact support if you need help.`;
  }
  if (snapshot.status === 'past_due') {
    return 'Your payment is past due. Update billing to keep using EstimateAce.';
  }
  if (snapshot.trialEndsAt) {
    const end = new Date(snapshot.trialEndsAt);
    if (!isNaN(end.getTime()) && end.getTime() <= now.getTime()) {
      return 'Your free trial has ended. Subscribe to keep using EstimateAce.';
    }
  }
  return 'An active subscription is required to use EstimateAce.';
}

export function formatPeriodEnd(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}
