/**
 * Capped card-free trial offers (6-month and legacy 3-month): first 20 signups each.
 *
 * The cap is enforced in Postgres (supabase/trial-offers-2026-11.sql):
 * claim_promo_spot() takes a per-promo advisory lock and a BEFORE INSERT trigger
 * refuses inserts past the limit, so concurrent signups can never exceed 20.
 * If the database functions are missing or error, we fail CLOSED (no spot) so the
 * cap can't be bypassed; the user falls back to the card-required standard trial.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { CARD_FREE_OFFER_LIMITS, type CardFreeOffer } from '@/lib/billing';

type Admin = SupabaseClient;

export type PromoSpotStatus = {
  promo: CardFreeOffer;
  limit: number;
  claimed: number;
  remaining: number;
  open: boolean;
};

export type PromoClaimResult = {
  ok: boolean;
  already: boolean;
  claimed: number;
  remaining: number;
  limit: number;
  error?: string;
};

function num(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function firstRow(data: unknown): Record<string, unknown> | null {
  if (Array.isArray(data)) return (data[0] as Record<string, unknown>) || null;
  if (data && typeof data === 'object') return data as Record<string, unknown>;
  return null;
}

export async function getPromoSpotStatus(admin: Admin, promo: CardFreeOffer): Promise<PromoSpotStatus> {
  const fallbackLimit = CARD_FREE_OFFER_LIMITS[promo];
  const { data, error } = await admin.rpc('promo_spot_status', { p_promo: promo });
  if (error) throw new Error(error.message);
  const row = firstRow(data);
  const limit = num(row?.max_redemptions, fallbackLimit);
  const claimed = Math.min(num(row?.claimed, 0), limit);
  const remaining = Math.max(0, num(row?.remaining, limit - claimed));
  return { promo, limit, claimed, remaining, open: remaining > 0 };
}

/** Reserve one spot for this user. Idempotent: a user who already holds a spot keeps it. */
export async function claimPromoSpot(
  admin: Admin,
  promo: CardFreeOffer,
  userId: string
): Promise<PromoClaimResult> {
  const limit = CARD_FREE_OFFER_LIMITS[promo];
  const id = String(userId || '').trim();
  if (!id) return { ok: false, already: false, claimed: limit, remaining: 0, limit };
  const { data, error } = await admin.rpc('claim_promo_spot', { p_promo: promo, p_user_id: id });
  if (error) {
    console.error(`claim_promo_spot(${promo}):`, error.message);
    return { ok: false, already: false, claimed: limit, remaining: 0, limit, error: error.message };
  }
  const row = firstRow(data);
  const rowLimit = num(row?.max_redemptions, limit);
  return {
    ok: row?.ok === true,
    already: row?.already === true,
    claimed: num(row?.claimed, rowLimit),
    remaining: Math.max(0, num(row?.remaining, 0)),
    limit: rowLimit,
  };
}
