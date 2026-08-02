import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/supabase/auth-user';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { getAppUrl, getStripe, getStripePriceId } from '@/lib/stripe-server';
import { isStripeConfigured } from '@/lib/billing';

async function ensureStripeCustomer(
  stripe: NonNullable<ReturnType<typeof getStripe>>,
  userId: string,
  email: string | undefined,
  existingCustomerId: string | null | undefined
): Promise<string> {
  // Reuse only if customer still exists in Stripe
  if (existingCustomerId) {
    try {
      const c = await stripe.customers.retrieve(existingCustomerId);
      if (c && !('deleted' in c && c.deleted)) {
        return existingCustomerId;
      }
    } catch {
      // deleted or invalid — create a new one below
    }
  }

  const customer = await stripe.customers.create({
    email: email || undefined,
    metadata: { supabase_user_id: userId },
  });
  return customer.id;
}

export async function POST(request: NextRequest) {
  try {
    if (!isStripeConfigured()) {
      return NextResponse.json(
        {
          error:
            'Stripe is not configured. Set STRIPE_SECRET_KEY and STRIPE_PRICE_ID in Vercel, then redeploy.',
        },
        { status: 503 }
      );
    }

    const { user, error } = await getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: error || 'Unauthorized' }, { status: 401 });
    }

    const stripe = getStripe()!;
    const priceId = getStripePriceId();
    const admin = getSupabaseAdmin();
    const appUrl = getAppUrl(request.url);

    let storedCustomerId: string | null = null;
    let storedStatus = 'trialing';
    let storedTrial: string | null = null;

    if (admin) {
      const { data } = await admin
        .from('subscriptions')
        .select('stripe_customer_id, status, trial_ends_at')
        .eq('user_id', user.id)
        .maybeSingle();
      storedCustomerId = data?.stripe_customer_id || null;
      storedStatus = data?.status || 'trialing';
      storedTrial = data?.trial_ends_at || null;
    }

    const customerId = await ensureStripeCustomer(
      stripe,
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
          customerChanged && storedStatus === 'active' ? 'canceled' : storedStatus || 'trialing',
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

    let session;
    try {
      session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        customer: customerId,
        client_reference_id: user.id,
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: `${appUrl}/?billing=success`,
        cancel_url: `${appUrl}/?billing=cancel`,
        allow_promotion_codes: true,
        subscription_data: {
          metadata: { supabase_user_id: user.id },
        },
        metadata: { supabase_user_id: user.id },
      });
    } catch (e: any) {
      // Race: customer deleted between retrieve and session create
      const msg = String(e?.message || '');
      if (msg.includes('No such customer') || e?.code === 'resource_missing') {
        const fresh = await stripe.customers.create({
          email: user.email || undefined,
          metadata: { supabase_user_id: user.id },
        });
        if (admin) {
          await admin.from('subscriptions').upsert({
            user_id: user.id,
            stripe_customer_id: fresh.id,
            stripe_subscription_id: null,
            status: 'trialing',
            trial_ends_at: storedTrial,
            updated_at: new Date().toISOString(),
          });
        }
        session = await stripe.checkout.sessions.create({
          mode: 'subscription',
          customer: fresh.id,
          client_reference_id: user.id,
          line_items: [{ price: priceId, quantity: 1 }],
          success_url: `${appUrl}/?billing=success`,
          cancel_url: `${appUrl}/?billing=cancel`,
          allow_promotion_codes: true,
          subscription_data: {
            metadata: { supabase_user_id: user.id },
          },
          metadata: { supabase_user_id: user.id },
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
