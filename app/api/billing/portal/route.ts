import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/supabase/auth-user';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { getAppUrl, getStripe } from '@/lib/stripe-server';
import { isStripeConfigured } from '@/lib/billing';

export async function POST(request: NextRequest) {
  try {
    if (!isStripeConfigured()) {
      return NextResponse.json({ error: 'Stripe is not configured.' }, { status: 503 });
    }

    const { user, error } = await getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: error || 'Unauthorized' }, { status: 401 });
    }

    const admin = getSupabaseAdmin();
    if (!admin) {
      return NextResponse.json(
        { error: 'SUPABASE_SERVICE_ROLE_KEY required for billing portal.' },
        { status: 503 }
      );
    }

    const { data } = await admin
      .from('subscriptions')
      .select('stripe_customer_id')
      .eq('user_id', user.id)
      .maybeSingle();

    if (!data?.stripe_customer_id) {
      return NextResponse.json(
        { error: 'No billing customer yet. Subscribe first.' },
        { status: 400 }
      );
    }

    const stripe = getStripe()!;
    const session = await stripe.billingPortal.sessions.create({
      customer: data.stripe_customer_id,
      return_url: `${getAppUrl(request.url)}/?billing=portal`,
    });

    return NextResponse.json({ url: session.url });
  } catch (e: any) {
    console.error('billing/portal:', e);
    return NextResponse.json({ error: e?.message || 'Portal failed' }, { status: 500 });
  }
}
