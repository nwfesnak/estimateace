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
        'owner_user_id, email, role, can_see_pricing, can_see_estimates_and_financials, crew_user_id'
      )
      .eq('crew_user_id', user.id)
      .maybeSingle();

    if (error) {
      // Table missing → treat as not crew (owners still work)
      if (error.code === '42P01') {
        return NextResponse.json({ isCrew: false });
      }
      console.error('crew/me:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    if (!row) {
      return NextResponse.json({ isCrew: false });
    }

    return NextResponse.json({
      isCrew: true,
      ownerUserId: row.owner_user_id,
      email: row.email || user.email,
      role: row.role === 'full' ? 'full' : 'limited',
      canSeePricing: row.can_see_pricing === true,
      canSeeEstimatesAndFinancials: row.can_see_estimates_and_financials === true,
    });
  } catch (e: any) {
    console.error('crew/me:', e);
    return NextResponse.json({ error: e?.message || 'Lookup failed' }, { status: 500 });
  }
}
