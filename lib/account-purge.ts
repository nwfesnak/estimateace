import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { getStripe } from '@/lib/stripe-server';

/** Hard-delete user data + auth after account_closes_at. */
export async function purgeClosedAccount(userId: string): Promise<{ ok: boolean; error?: string }> {
  const admin = getSupabaseAdmin();
  if (!admin) return { ok: false, error: 'No admin client' };

  try {
    const { data: subRow } = await admin
      .from('subscriptions')
      .select('stripe_subscription_id')
      .eq('user_id', userId)
      .maybeSingle();

    const stripe = getStripe();
    if (stripe && subRow?.stripe_subscription_id) {
      try {
        await stripe.subscriptions.cancel(subRow.stripe_subscription_id);
      } catch {
        /* may already be canceled */
      }
    }

    await admin.from('archive-est').delete().eq('user_id', userId);
    await admin.from('estimates').delete().eq('user_id', userId);
    await admin.from('subscriptions').delete().eq('user_id', userId);

    try {
      const { data: files } = await admin.storage.from('media').list(userId, { limit: 1000 });
      if (files?.length) {
        for (const f of files) {
          const { data: nested } = await admin.storage
            .from('media')
            .list(`${userId}/${f.name}`, { limit: 500 });
          if (nested?.length) {
            await admin.storage
              .from('media')
              .remove(nested.map((n) => `${userId}/${f.name}/${n.name}`));
          }
        }
        await admin.storage.from('media').remove(files.map((f) => `${userId}/${f.name}`));
      }
    } catch (e) {
      console.warn('storage purge:', e);
    }

    const { error } = await admin.auth.admin.deleteUser(userId);
    if (error) {
      console.error('auth deleteUser:', error);
      return { ok: false, error: error.message };
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || 'purge failed' };
  }
}

/** If account_closes_at is past, purge and return true. */
export async function purgeIfAccountClosed(userId: string): Promise<boolean> {
  const admin = getSupabaseAdmin();
  if (!admin) return false;

  const { data: row } = await admin
    .from('subscriptions')
    .select('account_closes_at')
    .eq('user_id', userId)
    .maybeSingle();

  let closesAt = row?.account_closes_at as string | null | undefined;

  if (!closesAt) {
    const { data: settings } = await admin
      .from('estimates')
      .select('profile')
      .eq('id', `SETTINGS-${userId}`)
      .maybeSingle();
    closesAt = settings?.profile?.accountClosesAt || null;
  }

  if (!closesAt) return false;
  const t = new Date(closesAt).getTime();
  if (isNaN(t) || t > Date.now()) return false;

  await purgeClosedAccount(userId);
  return true;
}
