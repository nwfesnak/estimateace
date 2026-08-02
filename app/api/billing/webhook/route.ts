import { NextRequest, NextResponse } from 'next/server';
import type Stripe from 'stripe';
import { getStripe } from '@/lib/stripe-server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import type { SubscriptionStatus } from '@/lib/billing';

export const runtime = 'nodejs';

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

async function upsertFromSubscription(
  sub: Stripe.Subscription,
  userIdHint?: string | null
) {
  const admin = getSupabaseAdmin();
  if (!admin) {
    console.error('webhook: missing service role');
    return;
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
    console.error('webhook: could not resolve user for subscription', sub.id);
    return;
  }

  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
  const priceId = sub.items?.data?.[0]?.price?.id || null;
  const periodEnd = (sub as any).current_period_end
    ? new Date((sub as any).current_period_end * 1000).toISOString()
    : null;
  const trialEnd = sub.trial_end
    ? new Date(sub.trial_end * 1000).toISOString()
    : null;

  await admin.from('subscriptions').upsert({
    user_id: userId,
    stripe_customer_id: customerId || null,
    stripe_subscription_id: sub.id,
    status: mapStatus(sub.status),
    price_id: priceId,
    current_period_end: periodEnd,
    trial_ends_at: trialEnd,
    cancel_at_period_end: !!sub.cancel_at_period_end,
    updated_at: new Date().toISOString(),
  });
}

export async function POST(request: NextRequest) {
  const stripe = getStripe();
  const secret = (process.env.STRIPE_WEBHOOK_SECRET || '').trim();
  if (!stripe || !secret) {
    return NextResponse.json({ error: 'Webhook not configured' }, { status: 503 });
  }

  const body = await request.text();
  const sig = request.headers.get('stripe-signature');
  if (!sig) {
    return NextResponse.json({ error: 'Missing signature' }, { status: 400 });
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, secret);
  } catch (err: any) {
    console.error('webhook signature:', err?.message);
    return NextResponse.json({ error: `Webhook Error: ${err?.message}` }, { status: 400 });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        const userId = (session.client_reference_id ||
          session.metadata?.supabase_user_id) as string | undefined;
        if (session.subscription) {
          const subId =
            typeof session.subscription === 'string'
              ? session.subscription
              : session.subscription.id;
          const sub = await stripe.subscriptions.retrieve(subId);
          await upsertFromSubscription(sub, userId || null);
        }
        break;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription;
        await upsertFromSubscription(sub);
        break;
      }
      default:
        break;
    }
  } catch (e) {
    console.error('webhook handler:', e);
    return NextResponse.json({ error: 'Handler failed' }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
