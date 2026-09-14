/**
 * AI Receptionist paid add-on — $49.99/month (separate from SaaS + crew seats).
 */
import type Stripe from 'stripe';
import { getStripe } from '@/lib/stripe-server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { getSubscriptionPeriodEnd } from '@/lib/billing-sync';
import { ensureStripeCustomerForOwner } from '@/lib/crew-billing';

export const RECEPTIONIST_ADDON_AMOUNT_CENTS = 4999;
export const RECEPTIONIST_ADDON_AMOUNT_DISPLAY = '$49.99';
export const RECEPTIONIST_ADDON_PURPOSE = 'receptionist_addon';

export function getReceptionistAddonPriceId(): string {
  return (process.env.STRIPE_PRICE_ID_RECEPTIONIST_ADDON || '').trim();
}

export type ReceptionistBilling = {
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  status?: string | null;
  currentPeriodEnd?: string | null;
  cancelAtPeriodEnd?: boolean;
};

export function isReceptionistAddonSubscription(sub: Stripe.Subscription): boolean {
  if (String(sub.metadata?.purpose || '') === RECEPTIONIST_ADDON_PURPOSE) return true;
  const priceId = getReceptionistAddonPriceId();
  if (priceId) {
    const items = sub.items?.data || [];
    if (items.some((it) => it.price?.id === priceId)) return true;
  }
  // Inline price_data product name fallback
  const items = sub.items?.data || [];
  return items.some((it) => {
    const name = String((it.price as any)?.product?.name || (it.price as any)?.nickname || '');
    return /receptionist/i.test(name) || Number(it.price?.unit_amount) === RECEPTIONIST_ADDON_AMOUNT_CENTS;
  });
}

export function receptionistAddonHasAccess(billing: ReceptionistBilling | null | undefined): boolean {
  if (!billing) return false;
  const status = String(billing.status || '').toLowerCase();
  const periodEnd = billing.currentPeriodEnd
    ? new Date(billing.currentPeriodEnd).getTime()
    : 0;
  const now = Date.now();
  if (status === 'active' || status === 'trialing' || status === 'past_due') return true;
  if ((status === 'canceled' || billing.cancelAtPeriodEnd) && periodEnd > now) return true;
  return false;
}

export async function loadReceptionistBilling(userId: string): Promise<ReceptionistBilling> {
  const admin = getSupabaseAdmin();
  if (!admin) return {};
  const { data } = await admin
    .from('estimates')
    .select('profile')
    .eq('id', `SETTINGS-${userId}`)
    .maybeSingle();
  const b = (data?.profile as any)?.receptionistBilling;
  return b && typeof b === 'object' ? (b as ReceptionistBilling) : {};
}

export async function upsertReceptionistAddonFromStripe(
  sub: Stripe.Subscription,
  fallbackUserId?: string | null
): Promise<{ ok: boolean; error?: string }> {
  const admin = getSupabaseAdmin();
  if (!admin) return { ok: false, error: 'No admin' };

  const userId =
    String(sub.metadata?.supabase_user_id || fallbackUserId || '').trim() || null;
  if (!userId) return { ok: false, error: 'Missing supabase_user_id on subscription' };

  const status = String(sub.status || 'incomplete');
  const periodEndIso = getSubscriptionPeriodEnd(sub);
  const billing: ReceptionistBilling = {
    stripeCustomerId:
      typeof sub.customer === 'string' ? sub.customer : sub.customer?.id || null,
    stripeSubscriptionId: sub.id,
    status,
    currentPeriodEnd: periodEndIso,
    cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end),
  };
  const active = receptionistAddonHasAccess(billing);

  const sid = `SETTINGS-${userId}`;
  const { data: existing } = await admin.from('estimates').select('profile').eq('id', sid).maybeSingle();
  const prev = (existing?.profile && typeof existing.profile === 'object' ? existing.profile : {}) as any;

  const { error } = await admin.from('estimates').upsert({
    id: sid,
    user_id: userId,
    jobName: '__settings__',
    documentType: 'settings',
    items: [],
    profile: {
      ...prev,
      receptionistBilling: billing,
      aiReceptionistAddonActive: active,
      // If subscription lapsed, turn off live answering flag (keep number config)
      ...(active
        ? {}
        : {
            receptionistConfig: prev.receptionistConfig
              ? { ...prev.receptionistConfig, enabled: false, status: prev.receptionistConfig.twilio?.phoneNumber ? 'disabled' : 'none' }
              : prev.receptionistConfig,
          }),
    },
    updated_at: new Date().toISOString(),
  });

  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/**
 * Pull latest receptionist add-on subscription from Stripe into SETTINGS.
 * Used after checkout success when webhooks are delayed/missing.
 */
export async function syncReceptionistAddonForUser(userId: string): Promise<{
  ok: boolean;
  active: boolean;
  billing: ReceptionistBilling;
  error?: string;
}> {
  const stripe = getStripe();
  if (!stripe) {
    const billing = await loadReceptionistBilling(userId);
    return {
      ok: false,
      active: receptionistAddonHasAccess(billing),
      billing,
      error: 'Stripe not configured',
    };
  }

  const customerId = await ensureStripeCustomerForOwner(userId);
  if (!customerId) {
    return { ok: false, active: false, billing: {}, error: 'No Stripe customer' };
  }

  // Prefer checkout session sync if we have a recent subscription on customer
  const subs = await stripe.subscriptions.list({
    customer: customerId,
    status: 'all',
    limit: 20,
    expand: ['data.items.data.price'],
  });

  let best: Stripe.Subscription | null = null;
  for (const sub of subs.data) {
    if (!isReceptionistAddonSubscription(sub)) continue;
    // Prefer active/trialing
    const rank = (s: string) =>
      s === 'active' || s === 'trialing' ? 3 : s === 'past_due' ? 2 : s === 'canceled' ? 1 : 0;
    if (!best || rank(sub.status) > rank(best.status)) best = sub;
  }

  if (!best) {
    // Also try matching by amount if metadata was missing on older checkouts
    for (const sub of subs.data) {
      const amt = sub.items?.data?.[0]?.price?.unit_amount;
      if (amt === RECEPTIONIST_ADDON_AMOUNT_CENTS) {
        best = sub;
        break;
      }
    }
  }

  if (!best) {
    const billing = await loadReceptionistBilling(userId);
    return {
      ok: true,
      active: receptionistAddonHasAccess(billing),
      billing,
    };
  }

  // Ensure metadata for future webhooks
  try {
    if (best.metadata?.purpose !== RECEPTIONIST_ADDON_PURPOSE) {
      await stripe.subscriptions.update(best.id, {
        metadata: {
          ...best.metadata,
          purpose: RECEPTIONIST_ADDON_PURPOSE,
          supabase_user_id: userId,
          saas_billing: 'false',
        },
      });
    }
  } catch {
    /* non-fatal */
  }

  const result = await upsertReceptionistAddonFromStripe(best, userId);
  const billing = await loadReceptionistBilling(userId);
  return {
    ok: result.ok,
    active: receptionistAddonHasAccess(billing),
    billing,
    error: result.error,
  };
}

/** Sync from a completed Checkout Session id (success_url ?session_id=) */
export async function syncReceptionistAddonFromCheckoutSession(
  sessionId: string,
  fallbackUserId?: string | null
): Promise<{ ok: boolean; active: boolean; error?: string }> {
  const stripe = getStripe();
  if (!stripe || !sessionId) {
    return { ok: false, active: false, error: 'Missing Stripe or session' };
  }
  const session = await stripe.checkout.sessions.retrieve(sessionId, {
    expand: ['subscription'],
  });
  const userId =
    String(session.client_reference_id || session.metadata?.supabase_user_id || fallbackUserId || '').trim();
  if (!userId) return { ok: false, active: false, error: 'No user on session' };

  if (session.metadata?.purpose && session.metadata.purpose !== RECEPTIONIST_ADDON_PURPOSE) {
    // Still allow if amount matches receptionist
  }

  let sub: Stripe.Subscription | null = null;
  if (session.subscription) {
    if (typeof session.subscription === 'string') {
      sub = await stripe.subscriptions.retrieve(session.subscription);
    } else {
      sub = session.subscription as Stripe.Subscription;
    }
  }
  if (!sub) {
    const synced = await syncReceptionistAddonForUser(userId);
    return { ok: synced.ok, active: synced.active, error: synced.error };
  }

  // Stamp purpose if missing
  if (sub.metadata?.purpose !== RECEPTIONIST_ADDON_PURPOSE) {
    try {
      sub = await stripe.subscriptions.update(sub.id, {
        metadata: {
          ...sub.metadata,
          purpose: RECEPTIONIST_ADDON_PURPOSE,
          supabase_user_id: userId,
          saas_billing: 'false',
        },
      });
    } catch {
      /* continue with existing */
    }
  }

  const result = await upsertReceptionistAddonFromStripe(sub, userId);
  const billing = await loadReceptionistBilling(userId);
  return {
    ok: result.ok,
    active: receptionistAddonHasAccess(billing),
    error: result.error,
  };
}

export { ensureStripeCustomerForOwner };
