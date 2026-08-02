import { NextRequest, NextResponse } from 'next/server';
import {
  DEFAULT_BILLING_SNAPSHOT,
  ensureTrialEndsAt,
  hasAppAccess,
  isBillingEnforced,
  isStripeConfigured,
  normalizeBillingSnapshot,
  type BillingSnapshot,
} from '@/lib/billing';
import { getUserFromRequest } from '@/lib/supabase/auth-user';
import { getSupabaseAdmin } from '@/lib/supabase/admin';

function rowToSnapshot(row: any): BillingSnapshot {
  if (!row) return { ...DEFAULT_BILLING_SNAPSHOT };
  return normalizeBillingSnapshot({
    status: row.status,
    stripeCustomerId: row.stripe_customer_id,
    stripeSubscriptionId: row.stripe_subscription_id,
    priceId: row.price_id,
    currentPeriodEnd: row.current_period_end,
    trialEndsAt: row.trial_ends_at,
    cancelAtPeriodEnd: row.cancel_at_period_end,
  });
}

export async function GET(request: NextRequest) {
  try {
    const { user, error } = await getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: error || 'Unauthorized' }, { status: 401 });
    }

    const admin = getSupabaseAdmin();
    let snapshot = { ...DEFAULT_BILLING_SNAPSHOT };

    if (admin) {
      const { data } = await admin
        .from('subscriptions')
        .select('*')
        .eq('user_id', user.id)
        .maybeSingle();

      snapshot = rowToSnapshot(data);

      // First-time trial seed when enforcing (or always track trial for UI)
      const withTrial = ensureTrialEndsAt(snapshot);
      if (
        !data ||
        (!data.trial_ends_at && withTrial.trialEndsAt) ||
        (data.status === 'none' && withTrial.status === 'trialing')
      ) {
        snapshot = withTrial;
        await admin.from('subscriptions').upsert({
          user_id: user.id,
          status: snapshot.status,
          trial_ends_at: snapshot.trialEndsAt,
          stripe_customer_id: snapshot.stripeCustomerId,
          stripe_subscription_id: snapshot.stripeSubscriptionId,
          price_id: snapshot.priceId,
          current_period_end: snapshot.currentPeriodEnd,
          cancel_at_period_end: snapshot.cancelAtPeriodEnd,
          updated_at: new Date().toISOString(),
        });
      }
    } else {
      // No service role — client-only trial fallback (not multi-device durable)
      snapshot = ensureTrialEndsAt(snapshot);
    }

    return NextResponse.json({
      billing: snapshot,
      access: hasAppAccess(snapshot),
      enforced: isBillingEnforced(),
      stripeConfigured: isStripeConfigured(),
    });
  } catch (e) {
    console.error('billing/status:', e);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
