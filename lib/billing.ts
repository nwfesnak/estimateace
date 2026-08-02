/**
 * EstimateAce SaaS billing (Phase A) — subscription for access to the product.
 * When Stripe is not configured or NEXT_PUBLIC_BILLING_ENFORCE is not "true",
 * all authenticated users keep full access (dev / soft launch).
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
};

export const DEFAULT_TRIAL_DAYS = 14;

export const DEFAULT_BILLING_SNAPSHOT: BillingSnapshot = {
  status: 'none',
  stripeCustomerId: null,
  stripeSubscriptionId: null,
  priceId: null,
  currentPeriodEnd: null,
  trialEndsAt: null,
  cancelAtPeriodEnd: false,
};

/** Client + server: only enforce paywall when explicitly enabled. */
export function isBillingEnforced(): boolean {
  return String(process.env.NEXT_PUBLIC_BILLING_ENFORCE || '').toLowerCase() === 'true';
}

export function isStripeConfigured(): boolean {
  return Boolean(
    (process.env.STRIPE_SECRET_KEY || '').trim() &&
      (process.env.STRIPE_PRICE_ID || '').trim()
  );
}

/** Server diagnostics for Profile billing UI */
export function getStripeConfigDiagnostics() {
  const hasSecretKey = Boolean((process.env.STRIPE_SECRET_KEY || '').trim());
  const hasPriceId = Boolean((process.env.STRIPE_PRICE_ID || '').trim());
  const hasWebhookSecret = Boolean((process.env.STRIPE_WEBHOOK_SECRET || '').trim());
  const hasServiceRole = Boolean((process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim());
  return {
    hasSecretKey,
    hasPriceId,
    hasWebhookSecret,
    hasServiceRole,
    configured: hasSecretKey && hasPriceId,
  };
}

export function getTrialDays(): number {
  const n = Number(process.env.NEXT_PUBLIC_TRIAL_DAYS || DEFAULT_TRIAL_DAYS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_TRIAL_DAYS;
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
  };
}

/** Start a free trial clock from first login/signup if none set. */
export function ensureTrialEndsAt(
  snapshot: BillingSnapshot,
  now = new Date()
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
  const end = new Date(now);
  end.setDate(end.getDate() + getTrialDays());
  return {
    ...snapshot,
    status: snapshot.status === 'none' ? 'trialing' : snapshot.status,
    trialEndsAt: end.toISOString(),
  };
}

export function hasAppAccess(snapshot: BillingSnapshot, now = new Date()): boolean {
  if (!isBillingEnforced()) return true;

  const status = snapshot.status;
  if (status === 'active' || status === 'trialing') return true;
  // Grace for past_due a short period is optional; Phase A blocks past_due when enforcing
  if (status === 'past_due') return false;

  if (snapshot.trialEndsAt) {
    const end = new Date(snapshot.trialEndsAt).getTime();
    if (!isNaN(end) && end > now.getTime()) return true;
  }

  // Canceled but still inside paid period
  if (snapshot.currentPeriodEnd && status === 'canceled') {
    const end = new Date(snapshot.currentPeriodEnd).getTime();
    if (!isNaN(end) && end > now.getTime()) return true;
  }

  return false;
}

export function accessBlockedReason(snapshot: BillingSnapshot, now = new Date()): string | null {
  if (hasAppAccess(snapshot, now)) return null;
  if (snapshot.status === 'past_due') {
    return 'Your payment is past due. Update billing to keep using EstimateAce.';
  }
  if (snapshot.trialEndsAt) {
    const end = new Date(snapshot.trialEndsAt);
    if (!isNaN(end.getTime()) && end.getTime() <= now.getTime()) {
      return `Your ${getTrialDays()}-day free trial has ended. Subscribe to continue.`;
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
