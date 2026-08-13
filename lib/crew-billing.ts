/**
 * Crew seat billing — $14.99/month per additional crew member.
 * Separate from EstimateAce SaaS plan. Zelle/mail never apply here (Stripe only).
 */
import type Stripe from 'stripe';
import { getStripe } from '@/lib/stripe-server';
import { getSubscriptionPeriodEnd } from '@/lib/billing-sync';
import { getSupabaseAdmin } from '@/lib/supabase/admin';

export const CREW_SEAT_AMOUNT_CENTS = 1499;
export const CREW_SEAT_AMOUNT_DISPLAY = '$14.99';
export const CREW_SEAT_PURPOSE = 'crew_seat';

export function getCrewSeatPriceId(): string {
  return (process.env.STRIPE_PRICE_ID_CREW_SEAT || '').trim();
}

export type CrewSeatRow = {
  id: string;
  owner_user_id: string;
  crew_member_id: string | null;
  crew_user_id: string | null;
  crew_email: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  status: string;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  amount_cents: number;
  currency: string;
};

/** Seat still grants login access (paid period not over). */
export function crewSeatHasAccess(seat: {
  status?: string | null;
  current_period_end?: string | null;
  cancel_at_period_end?: boolean | null;
}): boolean {
  const status = String(seat.status || '').toLowerCase();
  const periodEnd = seat.current_period_end ? new Date(seat.current_period_end).getTime() : 0;
  const now = Date.now();

  if (status === 'active' || status === 'trialing' || status === 'past_due') {
    return true;
  }
  // Canceled but paid through end of month
  if (
    (status === 'canceled' || seat.cancel_at_period_end) &&
    periodEnd > now
  ) {
    return true;
  }
  // Incomplete checkout — brief grace for just-created seats without sub yet
  if (status === 'incomplete' || status === 'pending') {
    return true;
  }
  return false;
}

export function mapCrewSeatStatus(status: Stripe.Subscription.Status | string): string {
  const s = String(status || 'incomplete');
  if (
    [
      'active',
      'trialing',
      'past_due',
      'canceled',
      'unpaid',
      'incomplete',
      'incomplete_expired',
      'paused',
    ].includes(s)
  ) {
    return s;
  }
  return 'incomplete';
}

export async function ensureStripeCustomerForOwner(
  ownerUserId: string,
  email?: string | null,
  existingCustomerId?: string | null
): Promise<string | null> {
  const stripe = getStripe();
  if (!stripe) return null;

  if (existingCustomerId) {
    try {
      const c = await stripe.customers.retrieve(existingCustomerId);
      if (c && !('deleted' in c && c.deleted)) return existingCustomerId;
    } catch {
      /* create new */
    }
  }

  const admin = getSupabaseAdmin();
  if (admin) {
    const { data } = await admin
      .from('subscriptions')
      .select('stripe_customer_id')
      .eq('user_id', ownerUserId)
      .maybeSingle();
    if (data?.stripe_customer_id) {
      try {
        const c = await stripe.customers.retrieve(data.stripe_customer_id);
        if (c && !('deleted' in c && c.deleted)) return data.stripe_customer_id;
      } catch {
        /* fall through */
      }
    }
  }

  const customer = await stripe.customers.create({
    email: email || undefined,
    metadata: { supabase_user_id: ownerUserId },
  });

  if (admin) {
    await admin.from('subscriptions').upsert({
      user_id: ownerUserId,
      stripe_customer_id: customer.id,
      updated_at: new Date().toISOString(),
    });
  }

  return customer.id;
}

export async function upsertCrewSeatFromStripe(
  sub: Stripe.Subscription
): Promise<{ ok: boolean; error?: string }> {
  const admin = getSupabaseAdmin();
  if (!admin) return { ok: false, error: 'Missing service role' };

  if (sub.metadata?.purpose !== CREW_SEAT_PURPOSE) {
    return { ok: false, error: 'Not a crew seat subscription' };
  }

  const ownerUserId = String(sub.metadata?.supabase_user_id || sub.metadata?.owner_user_id || '');
  const crewEmail = String(sub.metadata?.crew_email || '').toLowerCase();
  const crewUserId = sub.metadata?.crew_user_id ? String(sub.metadata.crew_user_id) : null;
  const crewMemberId = sub.metadata?.crew_member_id
    ? String(sub.metadata.crew_member_id)
    : null;

  if (!ownerUserId || !crewEmail) {
    return { ok: false, error: 'Missing owner or crew email on subscription metadata' };
  }

  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id || null;
  const periodEnd = getSubscriptionPeriodEnd(sub);
  const status = mapCrewSeatStatus(sub.status);
  const cancelAtPeriodEnd = !!sub.cancel_at_period_end;

  const payload = {
    owner_user_id: ownerUserId,
    crew_member_id: crewMemberId,
    crew_user_id: crewUserId,
    crew_email: crewEmail,
    stripe_customer_id: customerId,
    stripe_subscription_id: sub.id,
    status,
    current_period_end: periodEnd,
    cancel_at_period_end: cancelAtPeriodEnd,
    amount_cents: CREW_SEAT_AMOUNT_CENTS,
    currency: 'usd',
    updated_at: new Date().toISOString(),
  };

  const { error } = await admin.from('crew_seat_subscriptions').upsert(payload, {
    onConflict: 'stripe_subscription_id',
  });

  if (error) {
    // Table may not exist yet or unique constraint name differs — try update/insert
    const { data: existing } = await admin
      .from('crew_seat_subscriptions')
      .select('id')
      .eq('stripe_subscription_id', sub.id)
      .maybeSingle();
    if (existing?.id) {
      const { error: uErr } = await admin
        .from('crew_seat_subscriptions')
        .update(payload)
        .eq('id', existing.id);
      if (uErr) return { ok: false, error: uErr.message };
    } else {
      const { error: iErr } = await admin.from('crew_seat_subscriptions').insert(payload);
      if (iErr) return { ok: false, error: iErr.message };
    }
  }

  // Mirror onto crew_members when we can match
  let memberQuery = admin.from('crew_members').select('id').eq('owner_user_id', ownerUserId);
  if (crewUserId) memberQuery = memberQuery.eq('crew_user_id', crewUserId);
  else memberQuery = memberQuery.eq('email', crewEmail);
  const { data: member } = await memberQuery.maybeSingle();

  if (member?.id) {
    const accessOk =
      status === 'active' ||
      status === 'trialing' ||
      status === 'past_due' ||
      (cancelAtPeriodEnd && periodEnd && new Date(periodEnd).getTime() > Date.now()) ||
      (status === 'canceled' && periodEnd && new Date(periodEnd).getTime() > Date.now());

    await admin
      .from('crew_members')
      .update({
        seat_status: accessOk ? (cancelAtPeriodEnd ? 'canceling' : status) : status,
        seat_period_end: periodEnd,
        seat_cancel_at_period_end: cancelAtPeriodEnd,
        stripe_subscription_id: sub.id,
        updated_at: new Date().toISOString(),
      })
      .eq('id', member.id);

    await admin
      .from('crew_seat_subscriptions')
      .update({
        crew_member_id: member.id,
        crew_user_id: crewUserId,
        updated_at: new Date().toISOString(),
      })
      .eq('stripe_subscription_id', sub.id);
  }

  // Fully ended: revoke seat after period
  if (
    (status === 'canceled' || status === 'unpaid' || status === 'incomplete_expired') &&
    (!periodEnd || new Date(periodEnd).getTime() <= Date.now())
  ) {
    // Leave member row; owner can delete. Mark seat expired.
    if (member?.id) {
      await admin
        .from('crew_members')
        .update({
          seat_status: 'expired',
          seat_cancel_at_period_end: false,
          updated_at: new Date().toISOString(),
        })
        .eq('id', member.id);
    }
  }

  return { ok: true };
}

export function isCrewSeatSubscription(sub: Stripe.Subscription | null | undefined): boolean {
  return sub?.metadata?.purpose === CREW_SEAT_PURPOSE;
}
