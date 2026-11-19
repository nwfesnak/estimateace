/**
 * A crew member deleted their own EstimateAce account: end the seat the owner pays for,
 * exactly like the owner deleting that crew member (lib/crew-billing cancelCrewSeatNow:
 * immediate cancel in Stripe, recorded in crew_seat_subscriptions). The owner flow sends
 * no notification, so neither does this.
 */
import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import { cancelCrewSeatNow, upsertCrewSeatFromStripe } from '@/lib/crew-billing';

type Membership = { owner_user_id: string; email: string | null; stripe_subscription_id: string | null };
type SeatRow = { owner_user_id: string; crew_email: string | null; stripe_subscription_id: string | null };

export type CrewSeatReleaseDeps = {
  memberships: (crewUserId: string) => Promise<Membership[]>;
  seatsByCrewUser: (crewUserId: string) => Promise<SeatRow[]>;
  seatsByOwnerEmail: (ownerUserId: string, email: string) => Promise<SeatRow[]>;
  cancel: typeof cancelCrewSeatNow;
};

export async function releaseSeatsForDeletedCrew(
  stripe: Pick<Stripe, 'subscriptions'>,
  crewUserId: string,
  deps: CrewSeatReleaseDeps,
  record: Parameters<typeof cancelCrewSeatNow>[2] = upsertCrewSeatFromStripe
): Promise<{ canceled: string[]; skipped: string[] }> {
  // subscription id → whose seat it should be (for the safety check)
  const wanted = new Map<string, { ownerUserId: string; crewEmail: string | null }>();
  const add = (id: string | null | undefined, ownerUserId: string, crewEmail: string | null) => {
    if (id && !wanted.has(id)) wanted.set(id, { ownerUserId, crewEmail });
  };

  for (const m of await deps.memberships(crewUserId)) {
    const email = (m.email || '').toLowerCase() || null;
    add(m.stripe_subscription_id, m.owner_user_id, email);
    if (email) {
      for (const s of await deps.seatsByOwnerEmail(m.owner_user_id, email)) {
        add(s.stripe_subscription_id, s.owner_user_id, email);
      }
    }
  }
  for (const s of await deps.seatsByCrewUser(crewUserId)) {
    add(s.stripe_subscription_id, s.owner_user_id, (s.crew_email || '').toLowerCase() || null);
  }

  const canceled: string[] = [];
  const skipped: string[] = [];
  for (const [subId, who] of wanted) {
    const outcome = await deps.cancel(stripe, subId, record, {
      crewUserId,
      crewEmail: who.crewEmail,
      ownerUserId: who.ownerUserId,
    });
    (outcome === 'canceled' ? canceled : skipped).push(subId);
  }
  return { canceled, skipped };
}

/** Supabase-backed lookups for releaseSeatsForDeletedCrew. */
export function crewSeatReleaseDeps(admin: SupabaseClient): CrewSeatReleaseDeps {
  return {
    memberships: async (crewUserId) => {
      const { data, error } = await admin
        .from('crew_members')
        .select('owner_user_id, email, stripe_subscription_id')
        .eq('crew_user_id', crewUserId);
      if (error) throw new Error(`crew_members: ${error.message}`);
      return (data as Membership[]) || [];
    },
    seatsByCrewUser: async (crewUserId) => {
      const { data, error } = await admin
        .from('crew_seat_subscriptions')
        .select('owner_user_id, crew_email, stripe_subscription_id')
        .eq('crew_user_id', crewUserId);
      if (error) throw new Error(`crew_seat_subscriptions: ${error.message}`);
      return (data as SeatRow[]) || [];
    },
    seatsByOwnerEmail: async (ownerUserId, email) => {
      const { data, error } = await admin
        .from('crew_seat_subscriptions')
        .select('owner_user_id, crew_email, stripe_subscription_id')
        .eq('owner_user_id', ownerUserId)
        .eq('crew_email', email);
      if (error) throw new Error(`crew_seat_subscriptions: ${error.message}`);
      return (data as SeatRow[]) || [];
    },
    cancel: cancelCrewSeatNow,
  };
}
