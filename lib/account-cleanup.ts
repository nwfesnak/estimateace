/**
 * Account deletion helpers: stop every recurring charge tied to an account (main plan,
 * crew seats, AI Receptionist add-on, Twilio number) and remove all of its files.
 */
import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import { loadReceptionistPrivate } from '@/lib/receptionist-private';
import { closeContractorSubaccount, releaseContractorNumber } from '@/lib/twilio-receptionist-provision';

const ENDED = new Set(['canceled', 'incomplete_expired']);
/** Still in a paid / trial period: cancel at period end when the user schedules closure. */
const RUNNING = new Set(['active', 'trialing', 'past_due']);

function isMissing(e: unknown): boolean {
  const err = e as { code?: string; statusCode?: number; message?: string } | null;
  return err?.code === 'resource_missing' || err?.statusCode === 404 || /No such subscription/i.test(err?.message || '');
}

/**
 * Every live Stripe subscription that belongs to this account: ids recorded in our
 * tables plus anything else on the account's own Stripe customers.
 */
export async function collectAccountSubscriptions(
  admin: SupabaseClient,
  stripe: Stripe,
  userId: string
): Promise<Stripe.Subscription[]> {
  const customerIds = new Set<string>();
  const subIds = new Set<string>();

  const { data: main } = await admin
    .from('subscriptions')
    .select('stripe_customer_id, stripe_subscription_id')
    .eq('user_id', userId)
    .maybeSingle();
  if (main?.stripe_customer_id) customerIds.add(String(main.stripe_customer_id));
  if (main?.stripe_subscription_id) subIds.add(String(main.stripe_subscription_id));

  const { data: seats } = await admin
    .from('crew_seat_subscriptions')
    .select('stripe_customer_id, stripe_subscription_id')
    .eq('owner_user_id', userId);
  for (const s of (seats as Array<{ stripe_customer_id?: string; stripe_subscription_id?: string }>) || []) {
    if (s.stripe_customer_id) customerIds.add(String(s.stripe_customer_id));
    if (s.stripe_subscription_id) subIds.add(String(s.stripe_subscription_id));
  }

  const receptionist = await loadReceptionistPrivate(userId);
  if (receptionist?.billing?.stripeCustomerId) customerIds.add(String(receptionist.billing.stripeCustomerId));
  if (receptionist?.billing?.stripeSubscriptionId) subIds.add(String(receptionist.billing.stripeSubscriptionId));

  const byId = new Map<string, Stripe.Subscription>();
  for (const customer of customerIds) {
    // Platform-account customers only (connected-account client plans are the
    // contractor's customers' subscriptions, not EstimateAce billing).
    for await (const sub of stripe.subscriptions.list({ customer, status: 'all', limit: 100 })) {
      byId.set(sub.id, sub);
    }
  }
  for (const id of subIds) {
    if (byId.has(id)) continue;
    try {
      byId.set(id, await stripe.subscriptions.retrieve(id));
    } catch (e) {
      if (!isMissing(e)) throw e;
    }
  }
  return [...byId.values()].filter((s) => !ENDED.has(s.status));
}

/**
 * mode 'period_end': user scheduled deletion; paid periods run out, nothing renews.
 * mode 'now': hard purge; cancel everything immediately.
 * Throws if any subscription could not be stopped (caller must not delete the account).
 */
export async function stopAccountBilling(
  admin: SupabaseClient,
  stripe: Stripe,
  userId: string,
  mode: 'period_end' | 'now'
): Promise<{ canceled: string[]; scheduled: string[] }> {
  const subs = await collectAccountSubscriptions(admin, stripe, userId);
  const canceled: string[] = [];
  const scheduled: string[] = [];
  const failures: string[] = [];
  for (const sub of subs) {
    try {
      if (mode === 'period_end' && RUNNING.has(sub.status)) {
        if (!sub.cancel_at_period_end) {
          await stripe.subscriptions.update(sub.id, { cancel_at_period_end: true });
        }
        scheduled.push(sub.id);
      } else {
        await stripe.subscriptions.cancel(sub.id);
        canceled.push(sub.id);
      }
    } catch (e) {
      if (isMissing(e)) continue;
      failures.push(`${sub.id}: ${(e as Error)?.message || e}`);
    }
  }
  if (failures.length) throw new Error(`Could not stop subscriptions: ${failures.join('; ')}`);
  return { canceled, scheduled };
}

/** Release the AI Receptionist number and close its Twilio subaccount. */
export async function releaseAccountPhoneLine(userId: string): Promise<{ released: boolean }> {
  const row = await loadReceptionistPrivate(userId);
  const line = row?.line;
  if (!line?.subaccountSid) return { released: false };
  if (line.numberSid && row?.subaccountAuthToken) {
    try {
      await releaseContractorNumber({
        subaccountSid: line.subaccountSid,
        subaccountAuthToken: row.subaccountAuthToken,
        numberSid: line.numberSid,
      });
    } catch (e) {
      console.warn('account cleanup: number release failed, closing subaccount instead:', (e as Error)?.message);
    }
  }
  await closeContractorSubaccount(line.subaccountSid);
  return { released: true };
}

/** Delete every object under `${userId}/` in the media bucket (recursive, paged). */
export async function deleteAllUserMedia(
  admin: SupabaseClient,
  userId: string,
  maxObjects = 100_000
): Promise<{ removed: number; complete: boolean }> {
  if (!/^[0-9a-f-]{36}$/i.test(userId)) throw new Error('Refusing media purge for a non-uuid folder');
  const bucket = admin.storage.from('media');
  const folders: string[] = [userId];
  let removed = 0;
  const PAGE = 1000;
  while (folders.length) {
    const folder = folders.pop() as string;
    // Re-list from offset 0 after each delete batch: removed files shift the pages.
    let offset = 0;
    let foldersSeen = 0;
    for (;;) {
      const { data, error } = await bucket.list(folder, { limit: PAGE, offset, sortBy: { column: 'name', order: 'asc' } });
      if (error) throw new Error(`list ${folder}: ${error.message}`);
      const entries = data || [];
      const files: string[] = [];
      for (const e of entries) {
        const full = `${folder}/${e.name}`;
        // Folders come back without an id.
        if (!e.id) {
          folders.push(full);
          foldersSeen++;
        } else files.push(full);
      }
      if (files.length) {
        const { error: rmErr } = await bucket.remove(files);
        if (rmErr) throw new Error(`remove in ${folder}: ${rmErr.message}`);
        removed += files.length;
        if (removed >= maxObjects) return { removed, complete: false };
      }
      if (entries.length < PAGE) break;
      // Files listed so far are gone; only the folders already queued sort ahead of
      // what is left, so skip exactly those.
      offset = foldersSeen;
    }
  }
  return { removed, complete: true };
}

/** Delete crew logins this owner created (they cannot be used without the owner). */
export async function deleteOwnerCrewLogins(admin: SupabaseClient, ownerId: string): Promise<number> {
  const { data } = await admin.from('crew_members').select('crew_user_id').eq('owner_user_id', ownerId);
  let deleted = 0;
  for (const row of (data as Array<{ crew_user_id?: string | null }>) || []) {
    const crewId = row.crew_user_id;
    if (!crewId || crewId === ownerId) continue;
    const { data: got } = await admin.auth.admin.getUserById(crewId);
    const meta = (got?.user?.app_metadata || {}) as { is_crew?: boolean; owner_user_id?: string };
    if (meta.is_crew !== true || meta.owner_user_id !== ownerId) continue;
    // Never delete a login that also runs its own workspace (real documents of its
    // own; a bare SETTINGS row doesn't count). Its crew_members row is still removed,
    // so it loses access to this workspace either way.
    const { count } = await admin
      .from('estimates')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', crewId)
      .not('id', 'like', 'SETTINGS-%');
    if ((count || 0) > 0) continue;
    const { error } = await admin.auth.admin.deleteUser(crewId);
    if (!error) deleted++;
  }
  return deleted;
}
