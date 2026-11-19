import { NextRequest, NextResponse } from 'next/server';
import {
  cardFreeOffer,
  cardTrialDaysForPromo,
  DEFAULT_BILLING_SNAPSHOT,
  ensureTrialEndsAt,
  getStripeConfigDiagnostics,
  hasAppAccess,
  isAccountClosed,
  isBillingEnforced,
  isEligibleForCardTrial,
  isStripeConfigured,
  normalizeBillingSnapshot,
  TRIAL_OFFERS,
  type BillingSnapshot,
} from '@/lib/billing';
import { claimPromoSpot } from '@/lib/promo-spots';
import { isEmailConfirmed } from '@/lib/send-guard';
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

      // Close date comes ONLY from the server-only subscriptions columns. It used to
      // fall back to the SETTINGS row, which users (and their crew) can edit.

      // Don't re-seed trial if closing
      if (!snapshot.accountClosesAt) {
        const meta = (user.user_metadata || {}) as Record<string, unknown>;
        let seed = snapshot;
        let promoDays: number | undefined;
        // Only the capped card-free offers (6mo) ever get an app-managed
        // trial seeded here, and only after an atomic spot claim. Standard and 2mo
        // accounts get no trial until Stripe Checkout (card on file) creates one.
        // Active (paid/comped) accounts never claim a spot.
        const freeOffer = cardFreeOffer(String(meta.promo || ''));
        if (
          freeOffer &&
          snapshot.status !== 'active' &&
          isEligibleForCardTrial(data) &&
          isEmailConfirmed(user)
        ) {
          const claim = await claimPromoSpot(admin, freeOffer, user.id);
          if (claim.ok) {
            seed = { ...snapshot, status: 'none', trialEndsAt: null };
            promoDays = TRIAL_OFFERS[freeOffer]();
          }
        }
        // ensureTrialEndsAt starts a new trial when none is set; we only want that for
        // a claimed card-free spot. Otherwise it just normalizes 'none' + future trial.
        const withTrial =
          promoDays != null
            ? ensureTrialEndsAt(seed, new Date(), promoDays)
            : snapshot.trialEndsAt
              ? ensureTrialEndsAt(snapshot)
              : snapshot;
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

        // Welcome email/SMS is ONLY sent from /api/billing/start-trial (landing-page signup).
        // Owner alert: start-trial covers instant signup. Email-confirm accounts have no
        // session yet, so the first billing poll (new subscription row, recent user) alerts once.
        if (!data && (user.app_metadata as { is_crew?: boolean } | null)?.is_crew !== true) {
          const createdMs = user.created_at ? new Date(user.created_at).getTime() : NaN;
          const recent =
            Number.isFinite(createdMs) && Date.now() - createdMs < 7 * 24 * 60 * 60 * 1000;
          if (recent) {
            try {
              const { maybeSendOwnerSignupAlert } = await import('@/lib/owner-signup-alert');
              const meta = (user.user_metadata || {}) as Record<string, unknown>;
              await maybeSendOwnerSignupAlert({
                admin,
                userId: user.id,
                email: user.email || '',
                phone: String(meta.phone || ''),
                name: String(meta.full_name || meta.name || ''),
                company: String(meta.company || ''),
                plan: String(meta.preferred_plan || ''),
              });
            } catch (alertErr) {
              console.warn('billing/status owner signup alert:', alertErr);
            }
          }
        }
      }
    } else {
      snapshot = ensureTrialEndsAt(snapshot);
    }

    const closed = isAccountClosed(snapshot);
    const stripeDiag = getStripeConfigDiagnostics();
    // New card-required accounts: tell the paywall how long the Checkout trial will be.
    const metaPromo = String(((user.user_metadata || {}) as Record<string, unknown>).promo || '');
    const cardTrialDays =
      snapshot.status === 'none' && !snapshot.trialEndsAt && !snapshot.stripeSubscriptionId
        ? cardTrialDaysForPromo(metaPromo)
        : null;
    return NextResponse.json({
      billing: snapshot,
      cardTrialDays,
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
