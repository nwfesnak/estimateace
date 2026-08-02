import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/supabase/auth-user';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { getAppUrl, getStripe, getStripePriceId } from '@/lib/stripe-server';
import { isStripeConfigured } from '@/lib/billing';

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

    let customerId: string | undefined;
    if (admin) {
      const { data } = await admin
        .from('subscriptions')
        .select('stripe_customer_id')
        .eq('user_id', user.id)
        .maybeSingle();
      customerId = data?.stripe_customer_id || undefined;
    }

    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email || undefined,
        metadata: { supabase_user_id: user.id },
      });
      customerId = customer.id;
      if (admin) {
        // Preserve trial/status — only attach customer id
        const { data: existing } = await admin
          .from('subscriptions')
          .select('status, trial_ends_at')
          .eq('user_id', user.id)
          .maybeSingle();
        await admin.from('subscriptions').upsert({
          user_id: user.id,
          stripe_customer_id: customerId,
          status: existing?.status || 'trialing',
          trial_ends_at: existing?.trial_ends_at || null,
          updated_at: new Date().toISOString(),
        });
      }
    }

    const session = await stripe.checkout.sessions.create({
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
