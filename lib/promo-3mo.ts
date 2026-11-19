/**
 * Legacy 3-month offer (?promo=3mo): first 20 signups, no card.
 * Now backed by the atomic Postgres claim in lib/promo-spots.ts.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { claimPromoSpot, getPromoSpotStatus } from '@/lib/promo-spots';

export async function getThreeMonthPromoStatus(admin: SupabaseClient) {
  const s = await getPromoSpotStatus(admin, '3mo');
  return { limit: s.limit, claimed: s.claimed, remaining: s.remaining, open: s.open };
}

export async function claimThreeMonthPromoSpot(admin: SupabaseClient, userId: string) {
  const r = await claimPromoSpot(admin, '3mo', userId);
  return { ok: r.ok, already: r.already, claimed: r.claimed, remaining: r.remaining };
}
