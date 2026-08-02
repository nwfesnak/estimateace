import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/supabase/auth-user';
import { getSupabaseAdmin } from '@/lib/supabase/admin';

/**
 * Owner invites a crew member: creates a real Supabase Auth user with the
 * password the owner sets, and links them to the owner workspace.
 */
export async function POST(request: NextRequest) {
  try {
    const { user, error: authError } = await getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: authError || 'Unauthorized' }, { status: 401 });
    }

    // Crew cannot invite other crew
    const admin = getSupabaseAdmin();
    if (!admin) {
      return NextResponse.json(
        { error: 'Server missing SUPABASE_SERVICE_ROLE_KEY.' },
        { status: 503 }
      );
    }

    const { data: selfCrew } = await admin
      .from('crew_members')
      .select('id')
      .eq('crew_user_id', user.id)
      .maybeSingle();
    if (selfCrew) {
      return NextResponse.json(
        { error: 'Crew accounts cannot invite other crew members.' },
        { status: 403 }
      );
    }

    const body = await request.json().catch(() => ({}));
    const email = String(body.email || '')
      .trim()
      .toLowerCase();
    const password = String(body.password || '');
    const role = body.role === 'full' ? 'full' : 'limited';
    const canSeePricing = Boolean(body.canSeePricing);
    const canSeeEstimatesAndFinancials = Boolean(body.canSeeEstimatesAndFinancials);

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ error: 'Valid email is required.' }, { status: 400 });
    }
    if (password.length < 6) {
      return NextResponse.json(
        { error: 'Password must be at least 6 characters.' },
        { status: 400 }
      );
    }
    if (email === (user.email || '').toLowerCase()) {
      return NextResponse.json(
        { error: 'You cannot add your own email as crew.' },
        { status: 400 }
      );
    }

    const { data: existingLink } = await admin
      .from('crew_members')
      .select('id, owner_user_id')
      .eq('email', email)
      .maybeSingle();
    if (existingLink) {
      if (existingLink.owner_user_id === user.id) {
        return NextResponse.json(
          { error: 'That email is already on your crew list.' },
          { status: 409 }
        );
      }
      return NextResponse.json(
        { error: 'That email is already a crew member on another account.' },
        { status: 409 }
      );
    }

    // Create or reuse auth user
    let crewUserId: string | null = null;
    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      app_metadata: {
        is_crew: true,
        owner_user_id: user.id,
      },
      user_metadata: {
        role: 'crew',
        invited_by: user.id,
      },
    });

    if (createError) {
      const msg = createError.message || '';
      // User may already exist (e.g. previous invite)
      if (/already|registered|exists/i.test(msg)) {
        const { data: listed } = await admin.auth.admin.listUsers({ perPage: 1000 });
        const found = listed?.users?.find((u) => (u.email || '').toLowerCase() === email);
        if (!found) {
          return NextResponse.json(
            { error: 'That email already has an account. Use a different email or reset their password.' },
            { status: 409 }
          );
        }
        // Only allow linking if they were already a crew account for this owner, or pure crew with no owner
        const metaOwner = found.app_metadata?.owner_user_id as string | undefined;
        const isCrew = found.app_metadata?.is_crew === true;
        if (!isCrew && metaOwner !== user.id) {
          // Check if they own estimates (main account)
          const { count } = await admin
            .from('estimates')
            .select('id', { count: 'exact', head: true })
            .eq('user_id', found.id);
          if ((count || 0) > 0 || !isCrew) {
            return NextResponse.json(
              {
                error:
                  'That email is already a full EstimateAce account. Ask them to use a different email for crew access.',
              },
              { status: 409 }
            );
          }
        }
        // Update password + metadata for re-invite
        const { error: updErr } = await admin.auth.admin.updateUserById(found.id, {
          password,
          email_confirm: true,
          app_metadata: {
            ...found.app_metadata,
            is_crew: true,
            owner_user_id: user.id,
          },
        });
        if (updErr) {
          return NextResponse.json({ error: updErr.message }, { status: 400 });
        }
        crewUserId = found.id;
      } else {
        return NextResponse.json({ error: msg || 'Could not create crew login.' }, { status: 400 });
      }
    } else {
      crewUserId = created.user?.id || null;
    }

    if (!crewUserId) {
      return NextResponse.json({ error: 'Could not create crew user.' }, { status: 500 });
    }

    const { data: row, error: insertError } = await admin
      .from('crew_members')
      .upsert(
        {
          owner_user_id: user.id,
          crew_user_id: crewUserId,
          email,
          role,
          can_see_pricing: canSeePricing,
          can_see_estimates_and_financials: canSeeEstimatesAndFinancials,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'crew_user_id' }
      )
      .select()
      .single();

    if (insertError) {
      console.error('crew_members insert:', insertError);
      return NextResponse.json(
        {
          error:
            insertError.message.includes('crew_members') || insertError.code === '42P01'
              ? 'Crew table missing. Run supabase/crew-members.sql in Supabase SQL Editor.'
              : insertError.message,
        },
        { status: 500 }
      );
    }

    return NextResponse.json({
      ok: true,
      crew: {
        email,
        userId: crewUserId,
        role,
        canSeePricing,
        canSeeEstimatesAndFinancials,
        id: row?.id,
      },
    });
  } catch (e: any) {
    console.error('crew invite:', e);
    return NextResponse.json({ error: e?.message || 'Invite failed' }, { status: 500 });
  }
}
