/**
 * Server-side paywall for API routes.
 *
 * The client shows <SubscriptionGate> when access is denied, but API routes must
 * enforce the same rule, otherwise an expired trial can keep calling AI, sending
 * documents, etc. directly. Crew members inherit the workspace owner's access.
 *
 * Only active when NEXT_PUBLIC_BILLING_ENFORCE=true (same flag as the client gate).
 * Accounts past their scheduled close date are always blocked.
 */
import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import {
  accessBlockedReason,
  DEFAULT_BILLING_SNAPSHOT,
  hasAppAccess,
  isBillingEnforced,
  normalizeBillingSnapshot,
  type BillingSnapshot,
} from '@/lib/billing';

export function subscriptionRowToSnapshot(row: Record<string, unknown> | null | undefined): BillingSnapshot {
  if (!row) return { ...DEFAULT_BILLING_SNAPSHOT };
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

async function resolveOwnerId(admin: NonNullable<ReturnType<typeof getSupabaseAdmin>>, userId: string) {
  try {
    const { data } = await admin
      .from('crew_members')
      .select('owner_user_id')
      .eq('crew_user_id', userId)
      .maybeSingle();
    const owner = String((data as { owner_user_id?: string } | null)?.owner_user_id || '').trim();
    if (owner && owner !== userId) return owner;
  } catch {
    /* crew table optional */
  }
  return userId;
}

/**
 * Returns a 402 response when the user (or their workspace owner, for crew)
 * has no app access; returns null when the request may continue.
 */
export async function enforceAppAccess(userId: string): Promise<NextResponse | null> {
  const admin = getSupabaseAdmin();
  if (!admin) return null; // cannot check without service role; client gate still applies

  const ownerId = await resolveOwnerId(admin, userId);
  const { data, error } = await admin
    .from('subscriptions')
    .select('*')
    .eq('user_id', ownerId)
    .maybeSingle();
  if (error) {
    console.warn('enforceAppAccess subscriptions read:', error.message);
    return null; // fail open on infra errors; never lock paying users out on a DB hiccup
  }

  // No row yet = brand-new account whose trial seeds on first /api/billing/status poll.
  if (!data) return null;

  const snapshot = subscriptionRowToSnapshot(data);
  if (hasAppAccess(snapshot)) return null;

  // hasAppAccess only blocks when enforcement is on (or the account is closed).
  return NextResponse.json(
    {
      error: accessBlockedReason(snapshot) || 'An active subscription is required.',
      code: 'subscription_required',
      enforced: isBillingEnforced(),
    },
    { status: 402 }
  );
}
