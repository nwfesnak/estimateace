import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/supabase/auth-user';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import {
  getAppUrl,
  getStripe,
  getStripePriceId,
  type BillingPlan,
} from '@/lib/stripe-server';
import type Stripe from 'stripe';
import { cardTrialDaysForPromo, isEligibleForCardTrial, isStripeConfigured } from '@/lib/billing';
import { ensureStripeCustomerForOwner } from '@/lib/crew-billing';

/** Stripe Checkout rejects subscription_data.trial_end less than 48h away; keep a buffer. */
const CHECKOUT_MIN_TRIAL_MS = 49 * 60 * 60 * 1000;

async function ensureStripeCustomer(
  userId: string,
  email: string | undefined,
  existingCustomerId: string | null | undefined
): Promise<string> {
  const id = await ensureStripeCustomerForOwner(userId, email, existingCustomerId);
  if (!id) throw new Error('Stripe is not configured');
  return id;
}

export async function POST(request: NextRequest) {
  try {
    if (!isStripeConfigured()) {
      return NextResponse.json(
        {
          error:
            'Stripe is not configured. Set STRIPE_SECRET_KEY and STRIPE_PRICE_ID_MONTHLY and/or STRIPE_PRICE_ID_YEARLY (or STRIPE_PRICE_ID) in Vercel, then redeploy.',
        },
        { status: 503 }
      );
    }

    const { user, error } = await getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: error || 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));
    const planRaw = String(body.plan || 'monthly').toLowerCase();
    const plan: BillingPlan = planRaw === 'yearly' ? 'yearly' : 'monthly';

    const stripe = getStripe()!;
    const priceId = getStripePriceId(plan);
    if (!priceId) {
      return NextResponse.json(
        {
          error:
            plan === 'yearly'
              ? 'Yearly plan is not configured. Add STRIPE_PRICE_ID_YEARLY in Vercel.'
              : 'Monthly plan is not configured. Add STRIPE_PRICE_ID_MONTHLY or STRIPE_PRICE_ID in Vercel.',
        },
        { status: 503 }
      );
    }

    const admin = getSupabaseAdmin();
    const appUrl = getAppUrl(request.url);

    let storedCustomerId: string | null = null;
    let storedStatus = 'trialing';
    let storedTrial: string | null = null;
    // Brand-new standard / 2-month accounts (never had a trial or subscription) start
    // their free trial here, with a card collected up front. Without a service-role
    // client we can't prove eligibility, so no new trial is granted.
    let cardTrialEligible = false;

    if (admin) {
      const { data } = await admin
        .from('subscriptions')
        .select('stripe_customer_id, stripe_subscription_id, status, trial_ends_at')
        .eq('user_id', user.id)
        .maybeSingle();
      storedCustomerId = data?.stripe_customer_id || null;
      storedStatus = data?.status || 'none';
      storedTrial = data?.trial_ends_at || null;
      cardTrialEligible = isEligibleForCardTrial(data);
    }

    const customerId = await ensureStripeCustomer(
      user.id,
      user.email,
      storedCustomerId
    );

    // Persist valid customer; clear stale subscription id if customer was recreated
    if (admin) {
      const customerChanged = customerId !== storedCustomerId;
      await admin.from('subscriptions').upsert({
        user_id: user.id,
        stripe_customer_id: customerId,
        stripe_subscription_id: customerChanged ? null : undefined,
        status:
          customerChanged && storedStatus === 'active' ? 'canceled' : storedStatus || 'none',
        trial_ends_at: storedTrial,
        updated_at: new Date().toISOString(),
      });
      if (customerChanged) {
        await admin
          .from('subscriptions')
          .update({
            stripe_customer_id: customerId,
            stripe_subscription_id: null,
            updated_at: new Date().toISOString(),
          })
          .eq('user_id', user.id);
      }
    }

    // Subscribing mid-trial keeps the rest of the free trial: Stripe won't charge until
    // the trial would have ended. Checkout requires trial_end to be at least 48h out, so
    // with less than ~2 days left the first charge happens at checkout instead.
    const subscriptionData: Stripe.Checkout.SessionCreateParams.SubscriptionData = {
      metadata: { supabase_user_id: user.id, plan },
    };
    const trialEndMs = storedTrial ? new Date(storedTrial).getTime() : NaN;
    const minTrialEndMs = Date.now() + CHECKOUT_MIN_TRIAL_MS;
    if (cardTrialEligible) {
      // Card-required trial: 14 days (standard) or 60 days (?promo=2mo). Card is
      // collected now; Stripe charges nothing until the trial ends.
      const promo = String((user.user_metadata as Record<string, unknown> | null)?.promo || '');
      subscriptionData.trial_period_days = cardTrialDaysForPromo(promo);
      subscriptionData.trial_settings = {
        end_behavior: { missing_payment_method: 'cancel' },
      };
      subscriptionData.metadata = {
        ...subscriptionData.metadata,
        signup_offer: promo.trim().toLowerCase() === '2mo' ? '2mo' : 'standard',
      };
    } else if (!isNaN(trialEndMs) && trialEndMs > minTrialEndMs) {
      subscriptionData.trial_end = Math.floor(trialEndMs / 1000);
      subscriptionData.trial_settings = {
        end_behavior: { missing_payment_method: 'cancel' },
      };
    }

    let session;
    try {
      session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        payment_method_collection: 'always',
        customer: customerId,
        client_reference_id: user.id,
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: `${appUrl}/?billing=success`,
        cancel_url: `${appUrl}/?billing=cancel`,
        allow_promotion_codes: true,
        subscription_data: subscriptionData,
        metadata: { supabase_user_id: user.id, plan },
      });
    } catch (e: any) {
      // Race: customer deleted between retrieve and session create
      const msg = String(e?.message || '');
      if (msg.includes('No such customer') || e?.code === 'resource_missing') {
        const fresh = await stripe.customers.create(
          {
            email: user.email || undefined,
            metadata: { supabase_user_id: user.id },
          },
          { idempotencyKey: `ea-customer-retry-${user.id}-${Math.floor(Date.now() / 3600000)}` }
        );
        if (admin) {
          await admin.from('subscriptions').upsert({
            user_id: user.id,
            stripe_customer_id: fresh.id,
            stripe_subscription_id: null,
            // Keep brand-new accounts at 'none' so they stay eligible for their card trial.
            status: storedStatus === 'none' ? 'none' : 'trialing',
            trial_ends_at: storedTrial,
            updated_at: new Date().toISOString(),
          });
        }
        session = await stripe.checkout.sessions.create({
          mode: 'subscription',
          payment_method_collection: 'always',
          customer: fresh.id,
          client_reference_id: user.id,
          line_items: [{ price: priceId, quantity: 1 }],
          success_url: `${appUrl}/?billing=success`,
          cancel_url: `${appUrl}/?billing=cancel`,
          allow_promotion_codes: true,
          subscription_data: subscriptionData,
          metadata: { supabase_user_id: user.id, plan },
        });
      } else {
        throw e;
      }
    }

    if (!session.url) {
      return NextResponse.json({ error: 'Stripe did not return a checkout URL' }, { status: 502 });
    }

    return NextResponse.json({ url: session.url });
  } catch (e: any) {
    console.error('billing/checkout:', e);
    return NextResponse.json(
      { error: e?.message || 'Checkout failed' },
      { status: 500 }
    );
  }
}
