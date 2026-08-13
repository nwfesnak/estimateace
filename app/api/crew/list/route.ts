import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/supabase/auth-user';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { crewSeatHasAccess } from '@/lib/crew-billing';

/**
 * Owner: list all crew members from DB (source of truth).
 * UI profile.teammates can get out of sync after failed checkout / reload.
 */
export async function GET(request: NextRequest) {
  try {
    const { user, error: authError } = await getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: authError || 'Unauthorized' }, { status: 401 });
    }

    const admin = getSupabaseAdmin();
    if (!admin) {
      return NextResponse.json(
        { error: 'Server missing SUPABASE_SERVICE_ROLE_KEY.' },
        { status: 503 }
      );
    }

    // Crew cannot list other crew
    const { data: selfCrew } = await admin
      .from('crew_members')
      .select('id')
      .eq('crew_user_id', user.id)
      .maybeSingle();
    if (selfCrew) {
      return NextResponse.json({ error: 'Crew accounts cannot list crew.' }, { status: 403 });
    }

    const { data: rows, error } = await admin
      .from('crew_members')
      .select(
        'id, email, crew_user_id, role, can_see_pricing, can_see_estimates_and_financials, seat_status, seat_period_end, seat_cancel_at_period_end, stripe_subscription_id, created_at'
      )
      .eq('owner_user_id', user.id)
      .order('created_at', { ascending: true });

    if (error) {
      if (error.code === '42P01') {
        return NextResponse.json({ ok: true, crew: [] });
      }
      // Older schema without seat columns
      if (error.message?.includes('seat_') || error.message?.includes('stripe_subscription')) {
        const { data: rows2, error: err2 } = await admin
          .from('crew_members')
          .select('id, email, crew_user_id, role, can_see_pricing, can_see_estimates_and_financials, created_at')
          .eq('owner_user_id', user.id)
          .order('created_at', { ascending: true });
        if (err2) {
          return NextResponse.json({ error: err2.message }, { status: 500 });
        }
        return NextResponse.json({
          ok: true,
          crew: (rows2 || []).map((r: any) => ({
            id: r.id,
            email: r.email,
            userId: r.crew_user_id,
            role: r.role === 'full' ? 'full' : 'limited',
            canSeePricing: r.can_see_pricing === true,
            canSeeEstimatesAndFinancials: r.can_see_estimates_and_financials === true,
            seatStatus: 'active',
            seatPeriodEnd: null,
            seatCancelAtPeriodEnd: false,
            stripeSubscriptionId: null,
            hasSeatAccess: true,
            needsSeatPayment: false,
          })),
        });
      }
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // Join seat subscriptions for payment status
    const { data: seats } = await admin
      .from('crew_seat_subscriptions')
      .select('*')
      .eq('owner_user_id', user.id);

    const seatsByEmail = new Map<string, any>();
    const seatsByUser = new Map<string, any>();
    for (const s of seats || []) {
      if (s.crew_email) seatsByEmail.set(String(s.crew_email).toLowerCase(), s);
      if (s.crew_user_id) seatsByUser.set(String(s.crew_user_id), s);
      if (s.stripe_subscription_id) {
        /* keep latest by iterating order — seats ordered by created if we sort */
      }
    }

    const crew = (rows || []).map((r: any) => {
      const email = String(r.email || '').toLowerCase();
      const seat =
        seatsByUser.get(String(r.crew_user_id)) ||
        seatsByEmail.get(email) ||
        null;
      const seatStatus = String(
        r.seat_status || seat?.status || 'incomplete'
      ).toLowerCase();
      const periodEnd = r.seat_period_end || seat?.current_period_end || null;
      const cancelAtEnd = !!(r.seat_cancel_at_period_end || seat?.cancel_at_period_end);
      const hasAccess = crewSeatHasAccess({
        status: seatStatus,
        current_period_end: periodEnd,
        cancel_at_period_end: cancelAtEnd,
      });
      const paid =
        ['active', 'trialing', 'past_due'].includes(seatStatus) ||
        (cancelAtEnd && periodEnd && new Date(periodEnd).getTime() > Date.now()) ||
        (seatStatus === 'canceled' && periodEnd && new Date(periodEnd).getTime() > Date.now());
      const needsSeatPayment =
        !paid &&
        (!seat?.stripe_subscription_id ||
          seatStatus === 'incomplete' ||
          seatStatus === 'incomplete_expired' ||
          seatStatus === 'expired');

      return {
        id: r.id,
        email: r.email,
        userId: r.crew_user_id,
        role: r.role === 'full' ? 'full' : 'limited',
        canSeePricing: r.can_see_pricing === true,
        canSeeEstimatesAndFinancials: r.can_see_estimates_and_financials === true,
        seatStatus,
        seatPeriodEnd: periodEnd,
        seatCancelAtPeriodEnd: cancelAtEnd,
        stripeSubscriptionId: r.stripe_subscription_id || seat?.stripe_subscription_id || null,
        hasSeatAccess: hasAccess,
        needsSeatPayment,
      };
    });

    return NextResponse.json({ ok: true, crew });
  } catch (e: any) {
    console.error('crew/list:', e);
    return NextResponse.json({ error: e?.message || 'List failed' }, { status: 500 });
  }
}
