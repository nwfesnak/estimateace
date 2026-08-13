import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/supabase/auth-user';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { getAppUrl, getStripe } from '@/lib/stripe-server';
import {
  CREW_SEAT_AMOUNT_CENTS,
  CREW_SEAT_AMOUNT_DISPLAY,
  CREW_SEAT_PURPOSE,
  ensureStripeCustomerForOwner,
  getCrewSeatPriceId,
} from '@/lib/crew-billing';

/**
 * Start Stripe Checkout for a $14.99/mo crew seat (after crew login is created).
 * Body: { crewEmail, crewUserId?, crewMemberId? }
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

    // Owners only
    const { data: selfCrew } = await admin
      .from('crew_members')
      .select('id')
      .eq('crew_user_id', user.id)
      .maybeSingle();
    if (selfCrew) {
      return NextResponse.json(
        { error: 'Crew accounts cannot purchase crew seats.' },
        { status: 403 }
      );
    }

    const body = await request.json().catch(() => ({}));
    const crewEmail = String(body.crewEmail || '')
      .trim()
      .toLowerCase();
    const crewUserId = body.crewUserId ? String(body.crewUserId) : null;
    const crewMemberId = body.crewMemberId ? String(body.crewMemberId) : null;

    if (!crewEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(crewEmail)) {
      return NextResponse.json({ error: 'Valid crew email is required.' }, { status: 400 });
    }

    const customerId = await ensureStripeCustomerForOwner(user.id, user.email);
    if (!customerId) {
      return NextResponse.json({ error: 'Could not create Stripe customer.' }, { status: 500 });
    }

    const appUrl = getAppUrl(request.url);
    const priceId = getCrewSeatPriceId();

    const lineItems: any[] = priceId
      ? [{ price: priceId, quantity: 1 }]
      : [
          {
            price_data: {
              currency: 'usd',
              unit_amount: CREW_SEAT_AMOUNT_CENTS,
              recurring: { interval: 'month' },
              product_data: {
                name: 'EstimateAce Crew Seat',
                description: `Additional crew member login — ${CREW_SEAT_AMOUNT_DISPLAY}/month`,
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
      success_url: `${appUrl}/?billing=crew_seat_success&crew=${encodeURIComponent(crewEmail)}`,
      cancel_url: `${appUrl}/?billing=crew_seat_cancel&crew=${encodeURIComponent(crewEmail)}`,
      allow_promotion_codes: true,
      subscription_data: {
        metadata: {
          purpose: CREW_SEAT_PURPOSE,
          supabase_user_id: user.id,
          owner_user_id: user.id,
          crew_email: crewEmail,
          crew_user_id: crewUserId || '',
          crew_member_id: crewMemberId || '',
        },
      },
      metadata: {
        purpose: CREW_SEAT_PURPOSE,
        saas_billing: 'false',
        supabase_user_id: user.id,
        crew_email: crewEmail,
        crew_user_id: crewUserId || '',
        crew_member_id: crewMemberId || '',
      },
    });

    if (!session.url) {
      return NextResponse.json({ error: 'Stripe did not return a checkout URL.' }, { status: 502 });
    }

    // Record pending seat row (best-effort)
    try {
      await admin.from('crew_seat_subscriptions').insert({
        owner_user_id: user.id,
        crew_member_id: crewMemberId,
        crew_user_id: crewUserId,
        crew_email: crewEmail,
        stripe_customer_id: customerId,
        stripe_subscription_id: null,
        status: 'incomplete',
        amount_cents: CREW_SEAT_AMOUNT_CENTS,
        currency: 'usd',
        updated_at: new Date().toISOString(),
      });
    } catch {
      /* table optional until SQL is run */
    }

    return NextResponse.json({
      ok: true,
      url: session.url,
      amountDisplay: CREW_SEAT_AMOUNT_DISPLAY,
    });
  } catch (e: any) {
    console.error('crew/seat-checkout:', e);
    return NextResponse.json({ error: e?.message || 'Checkout failed' }, { status: 500 });
  }
}
