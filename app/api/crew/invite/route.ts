import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/supabase/auth-user';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { CREW_SEAT_PENDING, crewSeatHasAccess, setCrewLoginEnabled } from '@/lib/crew-billing';
import { enforceAppAccess } from '@/lib/billing-access';
import { rateLimit, tooManyRequests } from '@/lib/rate-limit';
import { findAuthUserByEmail, sendCrewSetupLink } from '@/lib/crew-setup-link';
import { normalizeCrewTabAccess } from '@/lib/crew-tab-access';

/**
 * Owner invites a crew member: creates a Supabase Auth login WITHOUT a password and
 * links it to the owner workspace. The login stays disabled until the $14.99 seat is
 * paid; then the crew member gets a one-time "set your password" link at their own
 * email (lib/crew-setup-link.ts). The owner never sets or sees a crew password, and an
 * existing login that is not already this owner's crew is never taken over.
 */
export async function POST(request: NextRequest) {
  try {
    const { user, error: authError } = await getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: authError || 'Unauthorized' }, { status: 401 });
    }
    const paywall = await enforceAppAccess(user.id);
    if (paywall) return paywall;

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

    {
      const hourly = await rateLimit(`crew-invite:h:${user.id}`, 60 * 60, 10);
      if (!hourly.allowed) return tooManyRequests(hourly, 'Too many crew invites. Try again later.');
      const daily = await rateLimit(`crew-invite:d:${user.id}`, 24 * 60 * 60, 30);
      if (!daily.allowed) return tooManyRequests(daily, 'Daily crew invite limit reached. Try again tomorrow.');
    }

    const body = await request.json().catch(() => ({}));
    const email = String(body.email || '')
      .trim()
      .toLowerCase();
    const role = body.role === 'full' ? 'full' : 'limited';
    const canSeePricing = Boolean(body.canSeePricing);
    const canSeeEstimatesAndFinancials = Boolean(body.canSeeEstimatesAndFinancials);
    const tabAccess = normalizeCrewTabAccess(body.tabAccess);

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ error: 'Valid email is required.' }, { status: 400 });
    }
    if (email === (user.email || '').toLowerCase()) {
      return NextResponse.json(
        { error: 'You cannot add your own email as crew.' },
        { status: 400 }
      );
    }

    let { data: existingLink, error: exLinkErr } = await admin
      .from('crew_members')
      .select(
        'id, owner_user_id, crew_user_id, role, can_see_pricing, can_see_estimates_and_financials, tab_access, email'
      )
      .eq('email', email)
      .maybeSingle();
    if (exLinkErr && (exLinkErr.code === '42703' || exLinkErr.message?.includes('tab_access'))) {
      ({ data: existingLink } = await admin
        .from('crew_members')
        .select(
          'id, owner_user_id, crew_user_id, role, can_see_pricing, can_see_estimates_and_financials, email'
        )
        .eq('email', email)
        .maybeSingle() as any);
    }
    if (existingLink) {
      if (existingLink.owner_user_id === user.id) {
        // Already on this owner's crew (often after failed Stripe checkout / UI desync).
        // Return the existing row so the UI can re-list + re-pay the seat. Never change
        // the crew member's password here.
        if (existingLink.crew_user_id) {
          const { data: seatRow } = await admin
            .from('crew_members')
            .select('seat_status, seat_period_end, seat_cancel_at_period_end')
            .eq('id', existingLink.id)
            .maybeSingle();
          const seat = seatRow as {
            seat_status?: string | null;
            seat_period_end?: string | null;
            seat_cancel_at_period_end?: boolean | null;
          } | null;
          const paid = seat
            ? crewSeatHasAccess({
                status: seat.seat_status,
                current_period_end: seat.seat_period_end,
                cancel_at_period_end: seat.seat_cancel_at_period_end,
              })
            : false;
          await setCrewLoginEnabled(existingLink.crew_user_id, paid);
          if (paid) {
            // Re-adding an active crew member re-sends their setup link (rate limited).
            await sendCrewSetupLink(admin, {
              crewUserId: existingLink.crew_user_id,
              email,
              ownerUserId: user.id,
              reason: 'resend',
            });
          }
        }
        return NextResponse.json({
          ok: true,
          alreadyExisted: true,
          crew: {
            email,
            userId: existingLink.crew_user_id,
            role: existingLink.role === 'full' ? 'full' : 'limited',
            canSeePricing: existingLink.can_see_pricing === true,
            canSeeEstimatesAndFinancials:
              existingLink.can_see_estimates_and_financials === true,
            tabAccess: normalizeCrewTabAccess((existingLink as any).tab_access),
            id: existingLink.id,
          },
          message:
            'That email was already on your crew (may have been hidden after a failed payment). Use Pay seat or open Manage billing to finish. If their seat is active, we emailed them a fresh link to set their password.',
        });
      }
      return NextResponse.json(
        { error: 'That email is already a crew member on another account.' },
        { status: 409 }
      );
    }

    // Never reuse an existing login: it may belong to someone else, or to a former
    // crew member who has since set their own password.
    let existingAuth: { id: string } | null = null;
    try {
      existingAuth = await findAuthUserByEmail(admin, email);
    } catch (e) {
      console.error('crew invite: user lookup', e);
      return NextResponse.json({ error: 'Could not check that email right now. Try again.' }, { status: 503 });
    }
    if (existingAuth) {
      return NextResponse.json(
        {
          error:
            'That email already has an EstimateAce login. Ask your crew member for a different email address for crew access.',
        },
        { status: 409 }
      );
    }

    // New login with no password: only the inbox owner can set one (setup link after
    // the seat is paid, or "Forgot your password?").
    let crewUserId: string | null = null;
    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email,
      email_confirm: true,
      ban_duration: '876000h',
      app_metadata: {
        is_crew: true,
        owner_user_id: user.id,
        crew_invite_mode: 'link',
      },
      user_metadata: {
        role: 'crew',
        invited_by: user.id,
      },
    });
    if (createError) {
      const msg = createError.message || '';
      if (/already|registered|exists/i.test(msg)) {
        return NextResponse.json(
          {
            error:
              'That email already has an EstimateAce login. Ask your crew member for a different email address for crew access.',
          },
          { status: 409 }
        );
      }
      return NextResponse.json({ error: msg || 'Could not create crew login.' }, { status: 400 });
    }
    crewUserId = created.user?.id || null;

    if (!crewUserId) {
      return NextResponse.json({ error: 'Could not create crew user.' }, { status: 500 });
    }

    const baseRow = {
      owner_user_id: user.id,
      crew_user_id: crewUserId,
      email,
      role,
      can_see_pricing: canSeePricing,
      can_see_estimates_and_financials: canSeeEstimatesAndFinancials,
      // Login stays disabled until the $14.99 seat is paid (seat webhook activates it).
      seat_status: CREW_SEAT_PENDING,
      updated_at: new Date().toISOString(),
    };
    let { data: row, error: insertError } = await admin
      .from('crew_members')
      .upsert({ ...baseRow, tab_access: tabAccess }, { onConflict: 'crew_user_id' })
      .select()
      .single();
    if (insertError && (insertError.code === '42703' || insertError.message?.includes('tab_access'))) {
      ({ data: row, error: insertError } = await admin
        .from('crew_members')
        .upsert(baseRow, { onConflict: 'crew_user_id' })
        .select()
        .single());
    }

    if (insertError) {
      console.error('crew_members insert:', insertError);
      // Don't leave an unlinked login behind (it would block re-inviting this email).
      await admin.auth.admin.deleteUser(crewUserId).catch(() => undefined);
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

    await setCrewLoginEnabled(crewUserId, false);

    return NextResponse.json({
      ok: true,
      seatPending: true,
      message:
        'Crew login created. As soon as the $14.99/month seat is paid, we email them a link to set their own password.',
      crew: {
        email,
        userId: crewUserId,
        role,
        canSeePricing,
        canSeeEstimatesAndFinancials,
        tabAccess: normalizeCrewTabAccess((row as any)?.tab_access ?? tabAccess),
        id: row?.id,
      },
    });
  } catch (e: any) {
    console.error('crew invite:', e);
    return NextResponse.json({ error: 'Invite failed' }, { status: 500 });
  }
}
