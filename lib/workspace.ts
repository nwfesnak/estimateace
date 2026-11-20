/**
 * One seat-aware answer to "whose workspace does this login act in?" for every
 * server route (service role). Mirrors public.is_crew_of():
 *   - owners (no crew row)           → their own workspace
 *   - crew with an active/paid seat  → the owner's workspace
 *   - crew whose seat is pending, expired or unpaid → refused (never the owner's data)
 */
import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import {
  crewHasTab,
  normalizeCrewTabAccess,
  type CrewTabAccess,
  type CrewTabKey,
} from '@/lib/crew-tab-access';

export type CrewSeatRow = {
  owner_user_id?: string | null;
  role?: string | null;
  can_see_pricing?: boolean | null;
  can_see_estimates_and_financials?: boolean | null;
  tab_access?: Record<string, unknown> | null;
  seat_status?: string | null;
  seat_period_end?: string | null;
};

/** Same seat rule as public.is_crew_of / is_full_access_crew_of. */
export function crewSeatIsActive(row: Pick<CrewSeatRow, 'seat_status' | 'seat_period_end'>): boolean {
  const status = String(row.seat_status || 'active').toLowerCase();
  if (['active', 'trialing', 'past_due', 'canceling'].includes(status)) return true;
  if (status === 'canceled' || status === 'unpaid') {
    const end = row.seat_period_end ? new Date(row.seat_period_end).getTime() : 0;
    return end > Date.now();
  }
  return false;
}

export type WorkspaceResolution =
  | { ok: true; ownerUserId: string; isCrew: boolean; crew: CrewSeatRow | null }
  | { ok: false; ownerUserId: null; isCrew: true; reason: 'crew_seat_inactive'; crew: CrewSeatRow };

const CREW_COLUMNS_LEGACY =
  'owner_user_id, role, can_see_pricing, can_see_estimates_and_financials, seat_status, seat_period_end';
const CREW_COLUMNS = `${CREW_COLUMNS_LEGACY}, tab_access`;

export async function resolveWorkspace(
  userId: string,
  adminClient?: SupabaseClient | null
): Promise<WorkspaceResolution> {
  const admin = adminClient ?? getSupabaseAdmin();
  if (!admin || !userId) return { ok: true, ownerUserId: userId, isCrew: false, crew: null };
  let row: CrewSeatRow | null = null;
  try {
    let { data, error } = await admin
      .from('crew_members')
      .select(CREW_COLUMNS)
      .eq('crew_user_id', userId)
      .maybeSingle();
    if (error && (error.code === '42703' || error.message?.includes('tab_access'))) {
      ({ data, error } = await admin
        .from('crew_members')
        .select(CREW_COLUMNS_LEGACY)
        .eq('crew_user_id', userId)
        .maybeSingle());
    }
    if (!error) row = (data as CrewSeatRow | null) || null;
  } catch {
    row = null;
  }
  const owner = String(row?.owner_user_id || '').trim();
  if (!row || !owner || owner === userId) {
    return { ok: true, ownerUserId: userId, isCrew: false, crew: null };
  }
  if (!crewSeatIsActive(row)) {
    return { ok: false, ownerUserId: null, isCrew: true, reason: 'crew_seat_inactive', crew: row };
  }
  return { ok: true, ownerUserId: owner, isCrew: true, crew: row };
}

export function crewSeatInactiveResponse(): NextResponse {
  return NextResponse.json(
    {
      error:
        'Your crew seat is not active yet (or has ended). Ask the account owner to pay or renew your $14.99/month seat.',
      code: 'crew_seat_inactive',
    },
    { status: 403 }
  );
}

export function crewTabAccessFromWorkspace(ws: WorkspaceResolution): CrewTabAccess {
  if (!ws.ok || !ws.isCrew || !ws.crew) return normalizeCrewTabAccess(null);
  return normalizeCrewTabAccess(ws.crew.tab_access);
}

export function crewCanAccessTab(
  ws: WorkspaceResolution,
  tab: CrewTabKey | readonly CrewTabKey[]
): boolean {
  if (!ws.ok) return false;
  if (!ws.isCrew) return true;
  const access = crewTabAccessFromWorkspace(ws);
  if (Array.isArray(tab)) {
    return tab.some((t) => crewHasTab(access, t));
  }
  return crewHasTab(access, tab as CrewTabKey);
}

/**
 * For routes: the workspace owner id, or a 403 response for a crew login whose seat
 * is not active or whose role/tab permissions forbid the action.
 */
export async function requireWorkspaceOwner(
  userId: string,
  adminClient?: SupabaseClient | null,
  options?: { requireFinancials?: boolean; requireTab?: CrewTabKey | readonly CrewTabKey[] }
): Promise<
  | { ownerUserId: string; isCrew: boolean; tabAccess: CrewTabAccess; denied?: undefined }
  | { denied: NextResponse }
> {
  const ws = await resolveWorkspace(userId, adminClient);
  if (!ws.ok) return { denied: crewSeatInactiveResponse() };
  if (options?.requireFinancials && !crewMayHandleClientMoney(ws)) {
    return { denied: crewPermissionDeniedResponse() };
  }
  if (options?.requireTab && !crewCanAccessTab(ws, options.requireTab)) {
    return { denied: crewPermissionDeniedResponse() };
  }
  return {
    ownerUserId: ws.ownerUserId,
    isCrew: ws.isCrew,
    tabAccess: crewTabAccessFromWorkspace(ws),
  };
}

/**
 * Customer-facing links (estimate/invoice approve + pay, terms, recurring plan links,
 * Stripe checkout) open the owner's real document with every price and total. Only the
 * owner and crew with full data access ("See pricing" AND "See estimates & financials",
 * the same rule as public.is_full_access_crew_of) may create or send them; restricted
 * crew only ever see redacted documents in the app.
 */
export function crewMayHandleClientMoney(ws: WorkspaceResolution): boolean {
  if (!ws.ok) return false;
  if (!ws.isCrew) return true;
  const row = ws.crew;
  return row?.can_see_pricing === true && row?.can_see_estimates_and_financials === true;
}

export function crewPermissionDeniedResponse(): NextResponse {
  return NextResponse.json(
    {
      error: "You don't have permission to do this. Ask the account owner.",
      code: 'crew_permission_denied',
    },
    { status: 403 }
  );
}
