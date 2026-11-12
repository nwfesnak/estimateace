/**
 * First 20 accounts that sign up with ?promo=3mo.
 * Spots live on one settings row so the count survives restarts.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { THREE_MONTH_PROMO_LIMIT } from '@/lib/billing';

const ROW_ID = 'PROMO-3MO-SIGNUPS';

type Admin = SupabaseClient;

function uniqueIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const item of value) {
    const id = String(item || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

async function readIds(admin: Admin): Promise<string[]> {
  const { data } = await admin.from('estimates').select('profile').eq('id', ROW_ID).maybeSingle();
  const profile = data?.profile && typeof data.profile === 'object' ? data.profile : {};
  return uniqueIds((profile as { userIds?: unknown }).userIds);
}

async function writeIds(admin: Admin, userId: string, ids: string[]): Promise<void> {
  const kept = uniqueIds(ids).slice(0, THREE_MONTH_PROMO_LIMIT);
  const { error } = await admin.from('estimates').upsert({
    id: ROW_ID,
    user_id: userId,
    jobName: '__promo_3mo__',
    documentType: 'settings',
    items: [],
    profile: {
      userIds: kept,
      limit: THREE_MONTH_PROMO_LIMIT,
      updatedAt: new Date().toISOString(),
    },
    updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(error.message);
}

export async function getThreeMonthPromoStatus(admin: Admin): Promise<{
  limit: number;
  claimed: number;
  remaining: number;
  open: boolean;
}> {
  const ids = await readIds(admin);
  const claimed = Math.min(ids.length, THREE_MONTH_PROMO_LIMIT);
  return {
    limit: THREE_MONTH_PROMO_LIMIT,
    claimed,
    remaining: Math.max(0, THREE_MONTH_PROMO_LIMIT - claimed),
    open: ids.length < THREE_MONTH_PROMO_LIMIT,
  };
}

/** Reserve one of the 20 spots. Already-reserved accounts can sign in again. */
export async function claimThreeMonthPromoSpot(
  admin: Admin,
  userId: string
): Promise<{ ok: boolean; already: boolean; claimed: number; remaining: number }> {
  const id = String(userId || '').trim();
  if (!id) return { ok: false, already: false, claimed: THREE_MONTH_PROMO_LIMIT, remaining: 0 };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const ids = await readIds(admin);
    if (ids.includes(id)) {
      const claimed = Math.min(ids.length, THREE_MONTH_PROMO_LIMIT);
      return {
        ok: true,
        already: true,
        claimed,
        remaining: Math.max(0, THREE_MONTH_PROMO_LIMIT - claimed),
      };
    }
    if (ids.length >= THREE_MONTH_PROMO_LIMIT) {
      return { ok: false, already: false, claimed: THREE_MONTH_PROMO_LIMIT, remaining: 0 };
    }
    await writeIds(admin, id, [...ids, id]);
    const after = await readIds(admin);
    if (after.includes(id) && after.indexOf(id) < THREE_MONTH_PROMO_LIMIT) {
      const claimed = Math.min(after.length, THREE_MONTH_PROMO_LIMIT);
      return {
        ok: true,
        already: false,
        claimed,
        remaining: Math.max(0, THREE_MONTH_PROMO_LIMIT - claimed),
      };
    }
  }

  const latest = await readIds(admin);
  const claimed = Math.min(latest.length, THREE_MONTH_PROMO_LIMIT);
  return {
    ok: latest.includes(id) && latest.indexOf(id) < THREE_MONTH_PROMO_LIMIT,
    already: latest.includes(id),
    claimed,
    remaining: Math.max(0, THREE_MONTH_PROMO_LIMIT - claimed),
  };
}
