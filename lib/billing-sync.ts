import type Stripe from 'stripe';
import { getStripe } from '@/lib/stripe-server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import type { SubscriptionStatus } from '@/lib/billing';

function mapStatus(status: Stripe.Subscription.Status | string): SubscriptionStatus {
  const s = String(status) as SubscriptionStatus;
  const allowed: SubscriptionStatus[] = [
    'trialing',
    'active',
    'past_due',
    'canceled',
    'unpaid',
    'incomplete',
    'incomplete_expired',
    'paused',
  ];
  return allowed.includes(s) ? s : 'none';
}

/** Unix seconds → ISO, or null */
function unixToIso(unix: unknown): string | null {
  const n = typeof unix === 'number' ? unix : Number(unix);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000).toISOString();
}

/**
 * Stripe API 2025-03-31+ removed subscription.current_period_end.
 * Period now lives on subscription items (and cancel_at as fallback).
 */
export function getSubscriptionPeriodEnd(sub: Stripe.Subscription): string | null {
  const s = sub as any;
  // Legacy top-level field (older API versions)
  const top = unixToIso(s.current_period_end);
  if (top) return top;

  // Current API: items.data[].current_period_end
  const items = s.items?.data;
  if (Array.isArray(items) && items.length > 0) {
    let maxEnd = 0;
    for (const item of items) {
      const end = Number(item?.current_period_end) || 0;
      if (end > maxEnd) maxEnd = end;
    }
    if (maxEnd > 0) return unixToIso(maxEnd);
  }

  // Scheduled cancel date
  if (s.cancel_at) return unixToIso(s.cancel_at);

  // Estimate from billing_cycle_anchor + price if needed
  const anchor = Number(s.billing_cycle_anchor || s.start_date) || 0;
  const interval = s.items?.data?.[0]?.price?.recurring?.interval as string | undefined;
  const intervalCount = Number(s.items?.data?.[0]?.price?.recurring?.interval_count) || 1;
  if (anchor > 0 && interval) {
    const d = new Date(anchor * 1000);
    if (interval === 'year') d.setFullYear(d.getFullYear() + intervalCount);
    else if (interval === 'month') d.setMonth(d.getMonth() + intervalCount);
    else if (interval === 'week') d.setDate(d.getDate() + 7 * intervalCount);
    else if (interval === 'day') d.setDate(d.getDate() + intervalCount);
    else return null;
    // If anchor is in the past, walk forward until next period end
    const now = Date.now();
    while (d.getTime() <= now) {
      if (interval === 'year') d.setFullYear(d.getFullYear() + intervalCount);
      else if (interval === 'month') d.setMonth(d.getMonth() + intervalCount);
      else if (interval === 'week') d.setDate(d.getDate() + 7 * intervalCount);
      else if (interval === 'day') d.setDate(d.getDate() + intervalCount);
      else break;
    }
    return d.toISOString();
  }

  return null;
}

export async function upsertSubscriptionFromStripe(
  sub: Stripe.Subscription,
  userIdHint?: string | null
): Promise<{ ok: boolean; userId?: string; error?: string }> {
  const admin = getSupabaseAdmin();
  if (!admin) {
    return { ok: false, error: 'Missing SUPABASE_SERVICE_ROLE_KEY' };
  }

  let userId =
    userIdHint ||
    (sub.metadata?.supabase_user_id as string | undefined) ||
    null;

  if (!userId && sub.customer) {
    const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
    const { data } = await admin
      .from('subscriptions')
      .select('user_id')
      .eq('stripe_customer_id', customerId)
      .maybeSingle();
    userId = data?.user_id || null;
  }

  if (!userId) {
    return { ok: false, error: 'Could not match Stripe subscription to a user' };
  }

  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
  const priceId = sub.items?.data?.[0]?.price?.id || null;
  const periodEnd = getSubscriptionPeriodEnd(sub);
  const trialEnd = sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null;

  // Keep existing trial_ends_at if Stripe has no trial on the sub
  const { data: existing } = await admin
    .from('subscriptions')
    .select('trial_ends_at')
    .eq('user_id', userId)
    .maybeSingle();

  const { error } = await admin.from('subscriptions').upsert({
    user_id: userId,
    stripe_customer_id: customerId || null,
    stripe_subscription_id: sub.id,
    status: mapStatus(sub.status),
    price_id: priceId,
    current_period_end: periodEnd,
    trial_ends_at: trialEnd || existing?.trial_ends_at || null,
    cancel_at_period_end: !!sub.cancel_at_period_end,
    updated_at: new Date().toISOString(),
  });

  if (error) {
    return { ok: false, userId, error: error.message };
  }
  return { ok: true, userId };
}

/**
 * Pull latest subscription from Stripe for this user and write to Supabase.
 * Used after Checkout when webhooks are delayed/misconfigured.
 */
export async function syncUserSubscriptionFromStripe(
  userId: string,
  userEmail?: string | null
): Promise<{
  ok: boolean;
  status?: string;
  error?: string;
}> {
  const stripe = getStripe();
  const admin = getSupabaseAdmin();
  if (!stripe) return { ok: false, error: 'Stripe not configured' };
  if (!admin) return { ok: false, error: 'Missing SUPABASE_SERVICE_ROLE_KEY' };

  const { data: row } = await admin
    .from('subscriptions')
    .select('stripe_customer_id, stripe_subscription_id')
    .eq('user_id', userId)
    .maybeSingle();

  let sub: Stripe.Subscription | null = null;
  let customerId = row?.stripe_customer_id || null;

  if (row?.stripe_subscription_id) {
    try {
      sub = await stripe.subscriptions.retrieve(row.stripe_subscription_id);
    } catch {
      // Subscription fully deleted in Stripe
      sub = null;
    }
  }

  if (!sub && customerId) {
    try {
      const list = await stripe.subscriptions.list({
        customer: customerId,
        status: 'all',
        limit: 10,
      });
      sub =
        list.data.find((s) => s.status === 'active' || s.status === 'trialing') ||
        list.data.find((s) => s.status === 'canceled') ||
        list.data[0] ||
        null;
    } catch {
      // Customer may have been deleted in Stripe
      customerId = null;
      sub = null;
    }
  }

  // Fallback: find Stripe customer by email
  if (!sub && userEmail) {
    const customers = await stripe.customers.list({ email: userEmail, limit: 5 });
    for (const c of customers.data) {
      const list = await stripe.subscriptions.list({
        customer: c.id,
        status: 'all',
        limit: 5,
      });
      const found =
        list.data.find((s) => s.status === 'active' || s.status === 'trialing') ||
        list.data.find((s) => s.status === 'canceled') ||
        list.data[0];
      if (found) {
        sub = found;
        customerId = c.id;
        break;
      }
    }
  }

  // No subscription in Stripe → clear local "active" so app matches Stripe
  if (!sub) {
    const { error } = await admin.from('subscriptions').upsert({
      user_id: userId,
      stripe_customer_id: customerId,
      stripe_subscription_id: null,
      status: 'canceled',
      price_id: null,
      current_period_end: null,
      cancel_at_period_end: false,
      updated_at: new Date().toISOString(),
    });
    if (error) return { ok: false, error: error.message };
    return {
      ok: true,
      status: 'canceled',
      error: undefined,
    };
  }

  const result = await upsertSubscriptionFromStripe(sub, userId);
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, status: mapStatus(sub.status) };
}
