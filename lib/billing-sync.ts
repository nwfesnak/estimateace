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
  const periodEnd = (sub as any).current_period_end
    ? new Date((sub as any).current_period_end * 1000).toISOString()
    : null;
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
      sub = null;
    }
  }

  if (!sub && customerId) {
    const list = await stripe.subscriptions.list({
      customer: customerId,
      status: 'all',
      limit: 10,
    });
    sub =
      list.data.find((s) => s.status === 'active' || s.status === 'trialing') ||
      list.data[0] ||
      null;
  }

  // Fallback: find Stripe customer by email (if checkout created customer but DB never linked)
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
        list.data[0];
      if (found) {
        sub = found;
        customerId = c.id;
        break;
      }
    }
  }

  if (!sub) {
    return {
      ok: false,
      error:
        'No Stripe subscription found for this login yet. In Stripe Dashboard → Subscriptions, confirm the payment exists. Then try Sync again. Also confirm STRIPE_WEBHOOK_SECRET and redeploy.',
    };
  }

  const result = await upsertSubscriptionFromStripe(sub, userId);
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, status: mapStatus(sub.status) };
}
