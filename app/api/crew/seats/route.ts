import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/supabase/auth-user';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { CREW_SEAT_AMOUNT_DISPLAY, crewSeatHasAccess } from '@/lib/crew-billing';

/**
 * List crew seat subscriptions for the owner (Manage plan & payment).
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

    const { data: seats, error } = await admin
      .from('crew_seat_subscriptions')
      .select('*')
      .eq('owner_user_id', user.id)
      .order('created_at', { ascending: false });

    if (error) {
      if (error.code === '42P01') {
        return NextResponse.json({
          ok: true,
          seats: [],
          priceDisplay: CREW_SEAT_AMOUNT_DISPLAY,
          note: 'Run supabase/crew-seat-subscriptions.sql in Supabase to enable crew seat billing history.',
        });
      }
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const list = (seats || []).map((s: any) => ({
      id: s.id,
      crewEmail: s.crew_email,
      crewUserId: s.crew_user_id,
      status: s.status,
      currentPeriodEnd: s.current_period_end,
      cancelAtPeriodEnd: !!s.cancel_at_period_end,
      amountDisplay: CREW_SEAT_AMOUNT_DISPLAY,
      stripeSubscriptionId: s.stripe_subscription_id,
      hasAccess: crewSeatHasAccess(s),
      label: `Crew seat — ${s.crew_email}`,
    }));

    return NextResponse.json({
      ok: true,
      seats: list,
      priceDisplay: CREW_SEAT_AMOUNT_DISPLAY,
    });
  } catch (e: any) {
    console.error('crew/seats:', e);
    return NextResponse.json({ error: e?.message || 'Failed' }, { status: 500 });
  }
}
