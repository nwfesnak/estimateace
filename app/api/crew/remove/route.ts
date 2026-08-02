import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/supabase/auth-user';
import { getSupabaseAdmin } from '@/lib/supabase/admin';

/**
 * Owner removes a crew member from their workspace.
 * Optionally deletes the auth user if they are marked as crew-only.
 */
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
    const crewUserId = body.crewUserId ? String(body.crewUserId) : null;

    if (!email && !crewUserId) {
      return NextResponse.json({ error: 'email or crewUserId required' }, { status: 400 });
    }

    let query = admin.from('crew_members').select('*').eq('owner_user_id', user.id);
    if (crewUserId) {
      query = query.eq('crew_user_id', crewUserId);
    } else {
      query = query.eq('email', email);
    }
    const { data: row, error } = await query.maybeSingle();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    if (!row) {
      return NextResponse.json({ error: 'Crew member not found on your account.' }, { status: 404 });
    }

    await admin.from('crew_members').delete().eq('id', row.id);

    // Delete auth user if they were created as crew-only
    try {
      const { data: authUser } = await admin.auth.admin.getUserById(row.crew_user_id);
      if (authUser?.user?.app_metadata?.is_crew === true) {
        await admin.auth.admin.deleteUser(row.crew_user_id);
      }
    } catch (e) {
      console.warn('crew remove: auth delete skipped', e);
    }

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error('crew remove:', e);
    return NextResponse.json({ error: e?.message || 'Remove failed' }, { status: 500 });
  }
}
