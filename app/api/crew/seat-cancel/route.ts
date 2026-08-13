import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/supabase/auth-user';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { getStripe } from '@/lib/stripe-server';
import { upsertCrewSeatFromStripe } from '@/lib/crew-billing';

/**
 * Cancel a crew seat at period end (crew keeps access until paid month ends).
 * Body: { subscriptionId } or { crewEmail }
 */
export async function POST(request: NextRequest) {
  try {
    const { user, error: authError } = await getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: authError || 'Unauthorized' }, { status: 401 });
    }

    const stripe = getStripe();
    if (!stripe) {
      return NextResponse.json({ error: 'Stripe is not configured.' }, { status: 503 });
    }

    const admin = getSupabaseAdmin();
    if (!admin) {
      return NextResponse.json(
        { error: 'Server missing SUPABASE_SERVICE_ROLE_KEY.' },
        { status: 503 }
      );
    }

    const body = await request.json().catch(() => ({}));
    const subscriptionId = body.subscriptionId ? String(body.subscriptionId) : '';
    const crewEmail = String(body.crewEmail || '')
      .trim()
      .toLowerCase();

    let subId = subscriptionId;
    if (!subId && crewEmail) {
      const { data: seat } = await admin
        .from('crew_seat_subscriptions')
        .select('stripe_subscription_id')
        .eq('owner_user_id', user.id)
        .eq('crew_email', crewEmail)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      subId = seat?.stripe_subscription_id || '';
    }

    if (!subId) {
      return NextResponse.json(
        { error: 'No Stripe subscription found for this crew seat.' },
        { status: 404 }
      );
    }

    // Verify ownership via our table
    const { data: owned } = await admin
      .from('crew_seat_subscriptions')
      .select('id')
      .eq('owner_user_id', user.id)
      .eq('stripe_subscription_id', subId)
      .maybeSingle();

    if (!owned) {
      return NextResponse.json({ error: 'Subscription not found on your account.' }, { status: 404 });
    }

    const updated = await stripe.subscriptions.update(subId, {
      cancel_at_period_end: true,
    });

    await upsertCrewSeatFromStripe(updated);

    return NextResponse.json({
      ok: true,
      cancelAtPeriodEnd: true,
      currentPeriodEnd: updated.cancel_at
        ? new Date(updated.cancel_at * 1000).toISOString()
        : null,
      message:
        'Crew seat canceled. They keep access until the end of the paid period, then the seat ends.',
    });
  } catch (e: any) {
    console.error('crew/seat-cancel:', e);
    return NextResponse.json({ error: e?.message || 'Cancel failed' }, { status: 500 });
  }
}
