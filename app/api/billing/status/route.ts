import { NextRequest, NextResponse } from 'next/server';
import {
  DEFAULT_BILLING_SNAPSHOT,
  ensureTrialEndsAt,
  getStripeConfigDiagnostics,
  hasAppAccess,
  isAccountClosed,
  isBillingEnforced,
  isStripeConfigured,
  normalizeBillingSnapshot,
  type BillingSnapshot,
} from '@/lib/billing';
import { getUserFromRequest } from '@/lib/supabase/auth-user';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { purgeIfAccountClosed } from '@/lib/account-purge';

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
    accountClosesAt: row.account_closes_at,
    deletionRequestedAt: row.deletion_requested_at,
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
      // If close date passed, purge and force re-login
      const purged = await purgeIfAccountClosed(user.id);
      if (purged) {
        return NextResponse.json({
          billing: { ...DEFAULT_BILLING_SNAPSHOT, accountClosesAt: new Date(0).toISOString() },
          access: false,
          accountClosed: true,
          enforced: true,
          stripeConfigured: isStripeConfigured(),
          stripe: getStripeConfigDiagnostics(),
          error: 'Account closed and data removed.',
        });
      }

      const { data } = await admin
        .from('subscriptions')
        .select('*')
        .eq('user_id', user.id)
        .maybeSingle();

      snapshot = rowToSnapshot(data);

      // Fallback close date from SETTINGS profile
      if (!snapshot.accountClosesAt) {
        const { data: settings } = await admin
          .from('estimates')
          .select('profile')
          .eq('id', `SETTINGS-${user.id}`)
          .maybeSingle();
        if (settings?.profile?.accountClosesAt) {
          snapshot = {
            ...snapshot,
            accountClosesAt: String(settings.profile.accountClosesAt),
            deletionRequestedAt: settings.profile.deletionRequestedAt
              ? String(settings.profile.deletionRequestedAt)
              : snapshot.deletionRequestedAt,
          };
        }
      }

      // Don't re-seed trial if closing
      if (!snapshot.accountClosesAt) {
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
      }
    } else {
      snapshot = ensureTrialEndsAt(snapshot);
    }

    const closed = isAccountClosed(snapshot);
    const stripeDiag = getStripeConfigDiagnostics();
    return NextResponse.json({
      billing: snapshot,
      access: hasAppAccess(snapshot),
      accountClosed: closed,
      enforced: isBillingEnforced() || closed,
      stripeConfigured: isStripeConfigured(),
      stripe: stripeDiag,
    });
  } catch (e) {
    console.error('billing/status:', e);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
