import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/supabase/auth-user';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import {
  cardFreeOffer,
  cardTrialDaysForPromo,
  ensureTrialEndsAt,
  hasAppAccess,
  isEligibleForCardTrial,
  isRetiredPromo,
  normalizeBillingSnapshot,
  normalizePromo,
  resolveTrialDaysFromPromo,
  TRIAL_OFFERS,
} from '@/lib/billing';
import { claimPromoSpot } from '@/lib/promo-spots';
import { EMAIL_NOT_CONFIRMED_MESSAGE, isEmailConfirmed } from '@/lib/send-guard';
import { rateLimit, serverError, tooManyRequests } from '@/lib/rate-limit';
import { signupFieldsFromMetadata } from '@/lib/signup-profile';

/**
 * Called by the /trial page right after signup. Seeds the company profile and
 * preferred plan (monthly|yearly), then:
 *  - standard / 2mo: does NOT grant any trial. The account has no access until the
 *    user finishes Stripe Checkout with a card (trial_period_days = offer length).
 *    Response has checkoutRequired: true and the page sends them to Checkout.
 *  - 6mo: card-free trial, but only if one of the 20 capped spots can be claimed
 *    atomically in Postgres. Full → 409 { full: true }.
 *  - Retired ?promo=3mo is treated as the standard card-required trial.
 * body.trialDays, if sent, must equal the offer's length (no arbitrary trial lengths).
 */
export async function POST(request: NextRequest) {
  try {
    const { user, error } = await getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: error || 'Unauthorized' }, { status: 401 });
    }

    // Called once by the /trial page after signup. Cap replays (each call can send a
    // welcome text/email and an owner alert).
    const replay = await rateLimit(`start-trial:${user.id}`, 24 * 60 * 60, 3);
    if (!replay.allowed) {
      return tooManyRequests(replay, 'Too many attempts. Please try again tomorrow or contact support.');
    }

    const body = await request.json().catch(() => ({}));
    const meta = signupFieldsFromMetadata(user);
    const plan =
      body.plan === 'yearly' || body.plan === 'monthly'
        ? body.plan
        : meta.preferredPlan === 'yearly'
          ? 'yearly'
          : 'monthly';
    const company = String(body.company || meta.company || '').trim().slice(0, 200);
    const name = String(body.name || meta.name || '').trim().slice(0, 120);
    const phone = String(body.phone || meta.phone || '').trim().slice(0, 40);
    const rawPromo = String(body.promo || meta.promo || '').trim();
    const promo = isRetiredPromo(rawPromo) ? '' : rawPromo;
    // Only approved offers (standard / 2mo / capped 6mo). Reject anything else
    // instead of silently honoring a client-chosen trial length.
    if (promo && !normalizePromo(promo)) {
      return NextResponse.json({ error: 'Unknown promo code.' }, { status: 400 });
    }
    const trialDays = resolveTrialDaysFromPromo(promo);
    if (body.trialDays != null && Number(body.trialDays) !== trialDays) {
      return NextResponse.json(
        { error: `Trial length must match the offer (${trialDays} days).` },
        { status: 400 }
      );
    }

    const admin = getSupabaseAdmin();
    if (!admin) {
      return NextResponse.json(
        { error: 'Server missing SUPABASE_SERVICE_ROLE_KEY' },
        { status: 503 }
      );
    }

    const { data: existing } = await admin
      .from('subscriptions')
      .select('*')
      .eq('user_id', user.id)
      .maybeSingle();

    let snapshot = normalizeBillingSnapshot({
      status: existing?.status,
      stripeCustomerId: existing?.stripe_customer_id,
      stripeSubscriptionId: existing?.stripe_subscription_id,
      priceId: existing?.price_id,
      currentPeriodEnd: existing?.current_period_end,
      trialEndsAt: existing?.trial_ends_at,
      cancelAtPeriodEnd: existing?.cancel_at_period_end,
      accountClosesAt: existing?.account_closes_at,
      deletionRequestedAt: existing?.deletion_requested_at,
    });

    // Welcome text/email + owner alert only go out when this call creates the
    // account's first billing record (never for existing / re-used accounts).
    const firstCreation =
      !existing ||
      (!existing.stripe_subscription_id &&
        !existing.stripe_customer_id &&
        !existing.trial_ends_at &&
        (!existing.status || existing.status === 'none'));

    const freeOffer = cardFreeOffer(promo);
    let checkoutRequired = false;

    // Active (paid or comped, e.g. the platform owner) accounts are never touched and
    // never consume a capped spot.
    if (snapshot.status !== 'active') {
      if (freeOffer) {
        // Capped card-free spots go only to confirmed email addresses (stops one person
        // burning all spots with made-up emails once email confirmation is on).
        if (!isEmailConfirmed(user)) {
          return NextResponse.json(
            { error: EMAIL_NOT_CONFIRMED_MESSAGE, code: 'email_not_confirmed' },
            { status: 403 }
          );
        }
        const claim = await claimPromoSpot(admin, freeOffer, user.id);
        if (!claim.ok) {
          const label = '6-month';
          return NextResponse.json(
            {
              error: claim.error
                ? `Could not reserve a ${label} spot right now. Please try again, or start the standard free trial.`
                : `This ${label} offer is full. All ${claim.limit} spots are taken. You can still start the standard free trial.`,
              full: !claim.error,
              limit: claim.limit,
              remaining: 0,
            },
            { status: claim.error ? 503 : 409 }
          );
        }
        if (!snapshot.trialEndsAt) {
          snapshot = ensureTrialEndsAt(
            { ...snapshot, status: 'none', trialEndsAt: null },
            new Date(),
            TRIAL_OFFERS[freeOffer]()
          );
        } else if (snapshot.status === 'none') {
          snapshot = { ...snapshot, status: 'trialing' };
        }
      } else {
        // Card-required offer: never seed an app-managed trial here. Existing trials
        // (older no-card accounts) are left exactly as they are.
        if (snapshot.trialEndsAt && snapshot.status === 'none') {
          snapshot = { ...snapshot, status: 'trialing' };
        }
        checkoutRequired = !hasAppAccess(snapshot) || isEligibleForCardTrial(existing);
      }
    }

    const subPayload: Record<string, unknown> = {
      user_id: user.id,
      status: snapshot.status,
      trial_ends_at: snapshot.trialEndsAt,
      stripe_customer_id: snapshot.stripeCustomerId,
      stripe_subscription_id: snapshot.stripeSubscriptionId,
      price_id: snapshot.priceId,
      current_period_end: snapshot.currentPeriodEnd,
      cancel_at_period_end: snapshot.cancelAtPeriodEnd,
      preferred_plan: plan,
      updated_at: new Date().toISOString(),
    };
    let { error: subErr } = await admin.from('subscriptions').upsert(subPayload);
    if (subErr) {
      // preferred_plan column may not exist yet
      delete subPayload.preferred_plan;
      const retry = await admin.from('subscriptions').upsert(subPayload);
      subErr = retry.error;
    }
    if (subErr) {
      console.warn('start-trial subscriptions:', subErr.message);
    }

    // Company profile seed on SETTINGS
    const { data: settings } = await admin
      .from('estimates')
      .select('profile')
      .eq('id', `SETTINGS-${user.id}`)
      .maybeSingle();

    const prev =
      settings?.profile && typeof settings.profile === 'object' ? settings.profile : {};
    const profile: Record<string, unknown> = {
      ...prev,
      company: company || (prev as any).company || '',
      name: name || (prev as any).name || '',
      phone: phone || (prev as any).phone || '',
      email: user.email || (prev as any).email || '',
      preferredBillingPlan: plan,
      ...(freeOffer ? { signupPromo: freeOffer } : {}),
    };

    await admin.from('estimates').upsert({
      id: `SETTINGS-${user.id}`,
      user_id: user.id,
      jobName: '__settings__',
      documentType: 'settings',
      items: [],
      profile,
      updated_at: new Date().toISOString(),
    });

    // Auto welcome email + SMS with walkthrough video (no CRM). Once per account.
    let welcomeOnboarding: unknown = null;
    if (firstCreation) try {
      const { maybeSendAndPersistWelcomeOnboarding } = await import('@/lib/welcome-onboarding');
      welcomeOnboarding = await maybeSendAndPersistWelcomeOnboarding({
        admin,
        userId: user.id,
        email: user.email || '',
        phone,
        name,
        company,
      });
    } catch (welcomeErr) {
      console.warn('start-trial welcome onboarding error:', welcomeErr);
    }

    // Email + text the platform owner once. Separate from the contractor welcome.
    let ownerSignupAlert: unknown = null;
    if (firstCreation) try {
      const { maybeSendOwnerSignupAlert } = await import('@/lib/owner-signup-alert');
      ownerSignupAlert = await maybeSendOwnerSignupAlert({
        admin,
        userId: user.id,
        email: user.email || '',
        phone,
        name,
        company,
        plan,
      });
    } catch (alertErr) {
      console.warn('start-trial owner signup alert error:', alertErr);
    }

    return NextResponse.json({
      ok: true,
      plan,
      promo: promo || null,
      trialDays: freeOffer ? trialDays : cardTrialDaysForPromo(promo),
      trialEndsAt: snapshot.trialEndsAt,
      status: snapshot.status,
      cardRequired: !freeOffer,
      checkoutRequired,
      welcomeOnboarding,
      ownerSignupAlert,
    });
  } catch (e: unknown) {
    return serverError('start-trial', e, 'Could not start your trial. Please try again.');
  }
}
