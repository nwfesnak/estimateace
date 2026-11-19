/**
 * Server-side crew access lookup (service role). Mirrors public.is_crew_of():
 * a crew login only counts while its seat is active (or paid through period end).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  buildItemIndex,
  crewHasFullDataAccess,
  restoreRow,
  type CrewAccess,
  type RestoreSources,
} from '@/lib/crew-redaction';

export type CrewAccessResult = CrewAccess & { role: 'full' | 'limited' };

function seatIsActive(row: { seat_status?: string | null; seat_period_end?: string | null }): boolean {
  const status = String(row.seat_status || 'active').toLowerCase();
  if (['active', 'trialing', 'past_due', 'canceling'].includes(status)) return true;
  if (status === 'canceled' || status === 'unpaid') {
    const end = row.seat_period_end ? new Date(row.seat_period_end).getTime() : 0;
    return end > Date.now();
  }
  return false;
}

/**
 * Returns the crew member's owner + permission flags, or null when the user is not
 * an active crew member of anyone (owners, expired seats, unlinked invites).
 */
export async function getCrewAccess(
  admin: SupabaseClient,
  userId: string
): Promise<CrewAccessResult | null> {
  const { data, error } = await admin
    .from('crew_members')
    .select('owner_user_id, role, can_see_pricing, can_see_estimates_and_financials, seat_status, seat_period_end')
    .eq('crew_user_id', userId)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as {
    owner_user_id?: string | null;
    role?: string | null;
    can_see_pricing?: boolean | null;
    can_see_estimates_and_financials?: boolean | null;
    seat_status?: string | null;
    seat_period_end?: string | null;
  };
  if (!row.owner_user_id || String(row.owner_user_id) === userId) return null;
  if (!seatIsActive(row)) return null;
  return {
    ownerId: String(row.owner_user_id),
    role: row.role === 'full' ? 'full' : 'limited',
    canSeePricing: row.can_see_pricing === true,
    canSeeFinancials: row.can_see_estimates_and_financials === true,
  };
}

/** Owner SETTINGS profile + (optionally) item index used to restore hidden values. */
export async function loadCrewRestoreSources(
  admin: SupabaseClient,
  access: CrewAccess,
  needItemIndex: boolean
): Promise<Omit<RestoreSources, 'existing'>> {
  const { data: settings } = await admin
    .from('estimates')
    .select('profile')
    .eq('id', `SETTINGS-${access.ownerId}`)
    .eq('user_id', access.ownerId)
    .maybeSingle();
  let itemIndex = new Map<string, Record<string, unknown>>();
  if (needItemIndex) {
    const { data: rows } = await admin
      .from('estimates')
      .select('items')
      .eq('user_id', access.ownerId)
      .not('id', 'like', 'SETTINGS-%')
      .order('updated_at', { ascending: false })
      .limit(1000);
    itemIndex = buildItemIndex((rows as Array<{ items?: unknown }>) || []);
  }
  const profile = (settings as { profile?: unknown } | null)?.profile;
  return {
    ownerSettingsProfile:
      profile && typeof profile === 'object' && !Array.isArray(profile)
        ? (profile as Record<string, unknown>)
        : null,
    itemIndex,
  };
}

/**
 * For server routes that save a document on a crew member's behalf: restore every
 * value the crew member cannot see from the owner's stored copy. No-op for owners
 * and fully-permitted crew.
 */
export async function restoreDocumentForCrewWrite<T extends Record<string, unknown>>(
  admin: SupabaseClient,
  userId: string,
  docId: string,
  row: T
): Promise<T> {
  const access = await getCrewAccess(admin, userId);
  if (!access || crewHasFullDataAccess(access)) return row;
  const { data: existing } = await admin
    .from('estimates')
    .select('*')
    .eq('id', docId)
    .eq('user_id', access.ownerId)
    .maybeSingle();
  const sources = await loadCrewRestoreSources(admin, access, !access.canSeePricing && !existing);
  return restoreRow(row, access, {
    ...sources,
    existing: (existing as Record<string, unknown> | null) || null,
  }) as T;
}

/**
 * documents/send builds the customer email from values the browser sends. A restricted
 * crew member's browser only holds redacted prices, so replace those with the owner's
 * stored values (the customer must still get the real estimate/invoice). Mutates `body`.
 */
export async function overlayStoredDocumentForCrewSend(
  admin: SupabaseClient,
  userId: string,
  body: Record<string, unknown>
): Promise<void> {
  const access = await getCrewAccess(admin, userId);
  if (!access || crewHasFullDataAccess(access)) return;
  const docId = String(body.invoiceNumber || '').trim();
  if (!docId) return;
  const { data } = await admin
    .from('estimates')
    .select('*')
    .eq('id', docId)
    .eq('user_id', access.ownerId)
    .maybeSingle();
  const stored = (data as Record<string, unknown> | null) || null;
  if (!stored) return;
  const sources = await loadCrewRestoreSources(admin, access, false);
  const settings = sources.ownerSettingsProfile || {};

  if (!access.canSeePricing) {
    const restored = restoreRow({ items: Array.isArray(body.items) ? body.items : [] }, access, {
      ...sources,
      existing: stored,
    });
    const items = Array.isArray(restored.items) ? restored.items : [];
    body.items = items;
    const { computeDocumentGrandTotal } = await import('@/lib/document-totals');
    body.grandTotal = computeDocumentGrandTotal({ ...stored, items });
    body.subtotalBeforeDiscount = 0; // send route recomputes from items
    const storedProfile = (stored.profile && typeof stored.profile === 'object' ? stored.profile : {}) as {
      _discount?: { discountAmount?: unknown; discountValue?: unknown; discountType?: unknown; discountDescription?: unknown };
    };
    const d = storedProfile._discount || {};
    body.discountAmount = Number(d.discountAmount) || 0;
    body.discountValue = Number(d.discountValue) || 0;
    body.discountType = d.discountType === 'percent' ? 'percent' : 'dollar';
    if (d.discountDescription) body.discountDescription = String(d.discountDescription);
    body.taxAmount = Number(stored.taxAmount ?? stored.taxamount) || 0;
    body.depositMinimumAmount = Math.max(0, Number(settings.depositMinimumAmount) || 0);
  }
  if (!access.canSeeFinancials) {
    body.amountPaid = Number(stored.amountPaid ?? stored.amountpaid) || 0;
    if (access.canSeePricing) {
      body.taxAmount = Number(stored.taxAmount ?? stored.taxamount) || Number(body.taxAmount) || 0;
    }
  }
}

/** True when the user is an active crew member without full data access. */
export async function getRestrictedCrewAccess(
  admin: SupabaseClient,
  userId: string
): Promise<CrewAccessResult | null> {
  const access = await getCrewAccess(admin, userId);
  if (!access || crewHasFullDataAccess(access)) return null;
  return access;
}
