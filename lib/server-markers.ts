/**
 * One-time, server-only markers stored on public.subscriptions (users can only
 * SELECT that table, so they cannot reset them). Replaces the old flags kept in the
 * user-writable SETTINGS row (welcomeOnboardingSentAt / ownerSignupAlertSentAt),
 * which let a user delete the flag and replay the welcome SMS / owner alert.
 *
 * Columns are added by supabase/security-hardening-2026-11b.sql.
 */
export type SubscriptionMarker = 'welcome_onboarding_sent_at' | 'owner_signup_alert_sent_at';

export type MarkerClaim = 'claimed' | 'already' | 'unavailable';

/**
 * Atomically set `column` = now() if it is still NULL. Only the caller that gets
 * 'claimed' may perform the one-time action. Fails closed ('unavailable') when the
 * row or column is missing so nothing is sent twice.
 */
export async function claimSubscriptionMarker(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped admin client
  admin: any,
  userId: string,
  column: SubscriptionMarker
): Promise<MarkerClaim> {
  if (!admin || !userId) return 'unavailable';
  try {
    const { data, error } = await admin
      .from('subscriptions')
      .update({ [column]: new Date().toISOString() })
      .eq('user_id', userId)
      .is(column, null)
      .select('user_id');
    if (error) {
      console.warn(`claimSubscriptionMarker(${column}):`, error.message);
      return 'unavailable';
    }
    if (Array.isArray(data) && data.length > 0) return 'claimed';
    const { data: row, error: readErr } = await admin
      .from('subscriptions')
      .select('user_id')
      .eq('user_id', userId)
      .maybeSingle();
    if (readErr || !row) return 'unavailable';
    return 'already';
  } catch (e) {
    console.warn(`claimSubscriptionMarker(${column}):`, e instanceof Error ? e.message : e);
    return 'unavailable';
  }
}
