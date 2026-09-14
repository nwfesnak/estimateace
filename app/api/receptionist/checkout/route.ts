import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/supabase/auth-user';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { getAppUrl, getStripe } from '@/lib/stripe-server';
import {
  RECEPTIONIST_ADDON_AMOUNT_CENTS,
  RECEPTIONIST_ADDON_AMOUNT_DISPLAY,
  RECEPTIONIST_ADDON_PURPOSE,
  ensureStripeCustomerForOwner,
  getReceptionistAddonPriceId,
  loadReceptionistBilling,
  receptionistAddonHasAccess,
} from '@/lib/receptionist-billing';

/**
 * POST /api/receptionist/checkout
 * Stripe Checkout for AI Receptionist add-on ($49.99/mo).
 * Must complete before Twilio line can be enabled.
 */
export async function POST(request: NextRequest) {
  try {
    const { user, error: authError } = await getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: authError || 'Unauthorized' }, { status: 401 });
    }

    const stripe = getStripe();
    if (!stripe) {
      return NextResponse.json(
        { error: 'Stripe is not configured. Set STRIPE_SECRET_KEY in Vercel.' },
        { status: 503 }
      );
    }

    const admin = getSupabaseAdmin();
    if (!admin) {
      return NextResponse.json(
        { error: 'Server missing SUPABASE_SERVICE_ROLE_KEY.' },
        { status: 503 }
      );
    }

    // Crew cannot purchase
    const { data: selfCrew } = await admin
      .from('crew_members')
      .select('id')
      .eq('crew_user_id', user.id)
      .maybeSingle();
    if (selfCrew) {
      return NextResponse.json(
        { error: 'Crew accounts cannot purchase the AI Receptionist add-on.' },
        { status: 403 }
      );
    }

    const existing = await loadReceptionistBilling(user.id);
    if (receptionistAddonHasAccess(existing)) {
      return NextResponse.json({
        ok: true,
        alreadyActive: true,
        message: 'AI Receptionist add-on is already active. You can enable your phone line.',
      });
    }

    const customerId = await ensureStripeCustomerForOwner(user.id, user.email);
    if (!customerId) {
      return NextResponse.json({ error: 'Could not create Stripe customer.' }, { status: 500 });
    }

    const appUrl = getAppUrl(request.url);
    const priceId = getReceptionistAddonPriceId();
    const lineItems: any[] = priceId
      ? [{ price: priceId, quantity: 1 }]
      : [
          {
            price_data: {
              currency: 'usd',
              unit_amount: RECEPTIONIST_ADDON_AMOUNT_CENTS,
              recurring: { interval: 'month' },
              product_data: {
                name: 'EstimateAce AI Receptionist',
                description: `AI phone receptionist add-on — ${RECEPTIONIST_ADDON_AMOUNT_DISPLAY}/month (dedicated Twilio line + live AI answering)`,
              },
            },
            quantity: 1,
          },
        ];

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      client_reference_id: user.id,
      line_items: lineItems,
      success_url: `${appUrl}/?billing=receptionist_success`,
      cancel_url: `${appUrl}/?billing=receptionist_cancel`,
      allow_promotion_codes: true,
      subscription_data: {
        metadata: {
          purpose: RECEPTIONIST_ADDON_PURPOSE,
          supabase_user_id: user.id,
          saas_billing: 'false',
        },
      },
      metadata: {
        purpose: RECEPTIONIST_ADDON_PURPOSE,
        supabase_user_id: user.id,
        saas_billing: 'false',
      },
    });

    if (!session.url) {
      return NextResponse.json({ error: 'Stripe did not return a checkout URL.' }, { status: 500 });
    }

    return NextResponse.json({
      ok: true,
      url: session.url,
      amountDisplay: RECEPTIONIST_ADDON_AMOUNT_DISPLAY,
    });
  } catch (e: any) {
    console.error('receptionist/checkout:', e);
    return NextResponse.json({ error: e?.message || 'Checkout failed' }, { status: 500 });
  }
}
