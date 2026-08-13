import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/supabase/auth-user';
import { getSupabaseAdmin } from '@/lib/supabase/admin';

/**
 * Resolve whether the logged-in user is crew on someone's workspace.
 * Used after main-form login so crew share the same email/password login as owners.
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

    const { data: row, error } = await admin
      .from('crew_members')
      .select(
        'owner_user_id, email, role, can_see_pricing, can_see_estimates_and_financials, crew_user_id, seat_status, seat_period_end, seat_cancel_at_period_end'
      )
      .eq('crew_user_id', user.id)
      .maybeSingle();

    if (error) {
      // Table missing → treat as not crew (owners still work)
      if (error.code === '42P01') {
        return NextResponse.json({ isCrew: false });
      }
      // Older schema without seat_* columns
      if (error.message?.includes('seat_')) {
        const { data: row2 } = await admin
          .from('crew_members')
          .select(
            'owner_user_id, email, role, can_see_pricing, can_see_estimates_and_financials, crew_user_id'
          )
          .eq('crew_user_id', user.id)
          .maybeSingle();
        if (!row2) return NextResponse.json({ isCrew: false });
        return NextResponse.json({
          isCrew: true,
          ownerUserId: row2.owner_user_id,
          email: row2.email || user.email,
          role: row2.role === 'full' ? 'full' : 'limited',
          canSeePricing: row2.can_see_pricing === true,
          canSeeEstimatesAndFinancials: row2.can_see_estimates_and_financials === true,
        });
      }
      console.error('crew/me:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    if (!row) {
      return NextResponse.json({ isCrew: false });
    }

    // Seat expired after cancel period — block workspace access
    const seatStatus = String((row as any).seat_status || 'active').toLowerCase();
    const periodEnd = (row as any).seat_period_end
      ? new Date((row as any).seat_period_end).getTime()
      : 0;
    if (seatStatus === 'expired') {
      return NextResponse.json({
        isCrew: false,
        seatExpired: true,
        error: 'This crew seat has ended. Ask the account owner to renew.',
      });
    }
    if (
      (seatStatus === 'canceled' || seatStatus === 'unpaid') &&
      periodEnd > 0 &&
      periodEnd <= Date.now()
    ) {
      return NextResponse.json({
        isCrew: false,
        seatExpired: true,
        error: 'This crew seat has ended. Ask the account owner to renew.',
      });
    }

    return NextResponse.json({
      isCrew: true,
      ownerUserId: row.owner_user_id,
      email: row.email || user.email,
      role: row.role === 'full' ? 'full' : 'limited',
      canSeePricing: row.can_see_pricing === true,
      canSeeEstimatesAndFinancials: row.can_see_estimates_and_financials === true,
      seatStatus,
      seatPeriodEnd: (row as any).seat_period_end || null,
      seatCancelAtPeriodEnd: !!(row as any).seat_cancel_at_period_end,
    });
  } catch (e: any) {
    console.error('crew/me:', e);
    return NextResponse.json({ error: e?.message || 'Lookup failed' }, { status: 500 });
  }
}
