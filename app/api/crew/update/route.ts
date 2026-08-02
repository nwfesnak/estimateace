import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/supabase/auth-user';
import { getSupabaseAdmin } from '@/lib/supabase/admin';

/** Owner updates crew role / permission flags. */
export async function POST(request: NextRequest) {
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

    const body = await request.json().catch(() => ({}));
    const email = String(body.email || '')
      .trim()
      .toLowerCase();
    if (!email) {
      return NextResponse.json({ error: 'email required' }, { status: 400 });
    }

    const patch: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    if (body.role === 'full' || body.role === 'limited') {
      patch.role = body.role;
    }
    if (typeof body.canSeePricing === 'boolean') {
      patch.can_see_pricing = body.canSeePricing;
    }
    if (typeof body.canSeeEstimatesAndFinancials === 'boolean') {
      patch.can_see_estimates_and_financials = body.canSeeEstimatesAndFinancials;
    }

    const { data, error } = await admin
      .from('crew_members')
      .update(patch)
      .eq('owner_user_id', user.id)
      .eq('email', email)
      .select()
      .maybeSingle();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    if (!data) {
      return NextResponse.json({ error: 'Crew member not found.' }, { status: 404 });
    }

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error('crew update:', e);
    return NextResponse.json({ error: e?.message || 'Update failed' }, { status: 500 });
  }
}
