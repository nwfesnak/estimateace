import { NextRequest, NextResponse } from 'next/server';
import { refuseInAppPurchase } from '@/lib/native-app-server';
import { getUserFromRequest } from '@/lib/supabase/auth-user';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { getAppUrl, getStripe } from '@/lib/stripe-server';
import type Stripe from 'stripe';
import { isStripeConfigured } from '@/lib/billing';
import { crewPermissionDeniedResponse, crewSeatInactiveResponse, resolveWorkspace } from '@/lib/workspace';

export async function POST(request: NextRequest) {
  // Store apps never start a purchase of plans / add-ons / seats (Apple 3.1.1, Google Play).
  const nativeBlocked = refuseInAppPurchase(request);
  if (nativeBlocked) return nativeBlocked;
  try {
    if (!isStripeConfigured()) {
      return NextResponse.json({ error: 'Stripe is not configured.' }, { status: 503 });
    }

    const { user, error } = await getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: error || 'Unauthorized' }, { status: 401 });
    }

    const ws = await resolveWorkspace(user.id);
    if (!ws.ok) return crewSeatInactiveResponse();
    if (ws.isCrew) return crewPermissionDeniedResponse();

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
    // Uses the account's default portal configuration (cancel at period end, update card,
    // invoice history, monthly <-> yearly). STRIPE_PORTAL_CONFIGURATION_ID pins a specific one.
    const configuration = (process.env.STRIPE_PORTAL_CONFIGURATION_ID || '').trim() || undefined;
    const params: Stripe.BillingPortal.SessionCreateParams = {
      customer: data.stripe_customer_id,
      return_url: `${getAppUrl(request.url)}/?billing=portal`,
    };
    if (configuration) params.configuration = configuration;

    try {
      const session = await stripe.billingPortal.sessions.create(params);
      return NextResponse.json({ url: session.url });
    } catch (e: unknown) {
      const err = e as { message?: string; code?: string };
      const msg = String(err?.message || '');
      if (configuration && /configuration/i.test(msg)) {
        // Pinned config was deleted/deactivated — fall back to the account default.
        delete params.configuration;
        const session = await stripe.billingPortal.sessions.create(params);
        return NextResponse.json({ url: session.url });
      }
      if (/No such customer/i.test(msg) || err?.code === 'resource_missing') {
        await admin
          .from('subscriptions')
          .update({ stripe_customer_id: null, updated_at: new Date().toISOString() })
          .eq('user_id', user.id);
        return NextResponse.json(
          { error: 'Your billing record was reset. Tap Subscribe to set up billing again.' },
          { status: 409 }
        );
      }
      if (/default configuration|portal settings|customer portal/i.test(msg)) {
        return NextResponse.json(
          {
            error:
              'Billing portal is not set up in Stripe yet. Contact support@estimateace.com to change or cancel your plan.',
          },
          { status: 503 }
        );
      }
      throw e;
    }
  } catch (e: any) {
    console.error('billing/portal:', e);
    return NextResponse.json({ error: 'Portal failed' }, { status: 500 });
  }
}
