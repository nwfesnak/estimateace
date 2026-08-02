import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/supabase/auth-user';
import { syncUserSubscriptionFromStripe } from '@/lib/billing-sync';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { DEFAULT_BILLING_SNAPSHOT, normalizeBillingSnapshot } from '@/lib/billing';

/** Pull subscription from Stripe into Supabase (fixes status stuck on none after Checkout). */
export async function POST(request: NextRequest) {
  try {
    const { user, error } = await getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: error || 'Unauthorized' }, { status: 401 });
    }

    const sync = await syncUserSubscriptionFromStripe(user.id, user.email);
    if (!sync.ok) {
      return NextResponse.json({ error: sync.error || 'Sync failed' }, { status: 400 });
    }

    const admin = getSupabaseAdmin();
    let billing = { ...DEFAULT_BILLING_SNAPSHOT };
    if (admin) {
      const { data } = await admin
        .from('subscriptions')
        .select('*')
        .eq('user_id', user.id)
        .maybeSingle();
      if (data) {
        billing = normalizeBillingSnapshot({
          status: data.status,
          stripeCustomerId: data.stripe_customer_id,
          stripeSubscriptionId: data.stripe_subscription_id,
          priceId: data.price_id,
          currentPeriodEnd: data.current_period_end,
          trialEndsAt: data.trial_ends_at,
          cancelAtPeriodEnd: data.cancel_at_period_end,
        });
      }
    }

    return NextResponse.json({ ok: true, status: sync.status, billing });
  } catch (e: any) {
    console.error('billing/sync:', e);
    return NextResponse.json({ error: e?.message || 'Sync failed' }, { status: 500 });
  }
}
