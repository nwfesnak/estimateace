import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/supabase/auth-user';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { getStripe } from '@/lib/stripe-server';
import {
  formatPeriodEnd,
  normalizeBillingSnapshot,
  resolveAccountCloseDate,
  type BillingSnapshot,
} from '@/lib/billing';
import { serverError } from '@/lib/rate-limit';
import { stopAccountBilling } from '@/lib/account-cleanup';

function rowToSnapshot(row: any): BillingSnapshot {
  if (!row) {
    return normalizeBillingSnapshot({});
  }
  return normalizeBillingSnapshot({
    status: row.status,
    stripeCustomerId: row.stripe_customer_id,
    stripeSubscriptionId: row.stripe_subscription_id,
    priceId: row.price_id,
    currentPeriodEnd: row.current_period_end,
    trialEndsAt: row.trial_ends_at,
    cancelAtPeriodEnd: row.cancel_at_period_end,
    accountClosesAt: row.account_closes_at,
    deletionRequestedAt: row.deletion_requested_at,
  });
}

/**
 * Schedule account closure at end of paid period (or trial).
 * User keeps access until that date; hard delete runs after.
 */
export async function POST(request: NextRequest) {
  try {
    const { user, error } = await getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: error || 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));
    const confirm = String(body.confirm || '').trim().toUpperCase();
    if (confirm !== 'DELETE') {
      return NextResponse.json(
        { error: 'Send { "confirm": "DELETE" } to schedule account deletion.' },
        { status: 400 }
      );
    }

    const admin = getSupabaseAdmin();
    if (!admin) {
      return NextResponse.json(
        { error: 'Server missing SUPABASE_SERVICE_ROLE_KEY.' },
        { status: 503 }
      );
    }

    const uid = user.id;
    const { data: subRow } = await admin
      .from('subscriptions')
      .select('*')
      .eq('user_id', uid)
      .maybeSingle();

    const snapshot = rowToSnapshot(subRow);
    const closesAt = resolveAccountCloseDate(snapshot);
    const closesAtIso = closesAt.toISOString();
    const nowIso = new Date().toISOString();

    // Stop renewals on EVERY subscription for this account (main plan, crew seats,
    // AI Receptionist add-on). Paid periods run out; nothing renews. Refuse to
    // schedule closure if a renewal could not be stopped.
    const stripe = getStripe();
    if (stripe) {
      try {
        await stopAccountBilling(admin, stripe, uid, 'period_end');
      } catch (e) {
        console.error('account/delete: could not stop renewals:', e);
        return NextResponse.json(
          { error: 'Could not cancel your subscriptions right now. Please try again or contact support.' },
          { status: 503 }
        );
      }
    }

    const { error: upsertErr } = await admin.from('subscriptions').upsert({
      user_id: uid,
      stripe_customer_id: subRow?.stripe_customer_id || null,
      stripe_subscription_id: subRow?.stripe_subscription_id || null,
      status: subRow?.status === 'active' || subRow?.status === 'trialing' ? subRow.status : 'canceled',
      price_id: subRow?.price_id || null,
      current_period_end: subRow?.current_period_end || closesAtIso,
      trial_ends_at: subRow?.trial_ends_at || null,
      cancel_at_period_end: true,
      account_closes_at: closesAtIso,
      deletion_requested_at: nowIso,
      updated_at: nowIso,
    });

    if (upsertErr) {
      // The close date must live in the server-only subscriptions row (never the
      // user-editable SETTINGS row), so refuse rather than store it somewhere unsafe.
      console.error('account/delete: could not store close date:', upsertErr.message);
      return NextResponse.json(
        { error: 'Could not schedule account deletion right now. Please try again or contact support.' },
        { status: 503 }
      );
    }

    // Display-only copy for the app UI. Never read by the server for purging.
    try {
      const { data: settings } = await admin
        .from('estimates')
        .select('profile')
        .eq('id', `SETTINGS-${uid}`)
        .maybeSingle();
      if (settings) {
        await admin
          .from('estimates')
          .update({
            profile: {
              ...(settings.profile && typeof settings.profile === 'object' ? settings.profile : {}),
              accountClosesAt: closesAtIso,
              deletionRequestedAt: nowIso,
            },
            updated_at: nowIso,
          })
          .eq('id', `SETTINGS-${uid}`)
          .eq('user_id', uid);
      }
    } catch {
      /* display copy only */
    }

    const label = formatPeriodEnd(closesAtIso);
    return NextResponse.json({
      ok: true,
      scheduled: true,
      accountClosesAt: closesAtIso,
      message: `Your account is scheduled to close on ${label}. You keep full access until that date. After that, access stops and your data is removed.`,
    });
  } catch (e: unknown) {
    return serverError('account/delete schedule', e, 'Failed to schedule deletion. Please try again.');
  }
}
