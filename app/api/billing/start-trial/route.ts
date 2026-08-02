import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/supabase/auth-user';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { ensureTrialEndsAt, getTrialDays, normalizeBillingSnapshot } from '@/lib/billing';

/**
 * Seed 14-day trial + preferred plan (monthly|yearly) after signup from /trial page.
 */
export async function POST(request: NextRequest) {
  try {
    const { user, error } = await getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: error || 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));
    const plan = body.plan === 'yearly' ? 'yearly' : 'monthly';
    const company = String(body.company || '').trim().slice(0, 200);
    const name = String(body.name || '').trim().slice(0, 120);
    const phone = String(body.phone || '').trim().slice(0, 40);

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

    // Only seed trial if not already active paid
    if (snapshot.status !== 'active') {
      if (!snapshot.trialEndsAt) {
        snapshot = ensureTrialEndsAt({ ...snapshot, status: 'none', trialEndsAt: null });
      } else if (snapshot.status === 'none') {
        snapshot = { ...snapshot, status: 'trialing' };
      }
    }

    const subPayload: Record<string, unknown> = {
      user_id: user.id,
      status: snapshot.status === 'active' ? 'active' : 'trialing',
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
    const profile = {
      ...prev,
      company: company || (prev as any).company || '',
      name: name || (prev as any).name || '',
      phone: phone || (prev as any).phone || '',
      email: user.email || (prev as any).email || '',
      preferredBillingPlan: plan,
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

    return NextResponse.json({
      ok: true,
      plan,
      trialDays: getTrialDays(),
      trialEndsAt: snapshot.trialEndsAt,
      status: snapshot.status === 'active' ? 'active' : 'trialing',
    });
  } catch (e: any) {
    console.error('start-trial:', e);
    return NextResponse.json({ error: e?.message || 'Failed' }, { status: 500 });
  }
}
