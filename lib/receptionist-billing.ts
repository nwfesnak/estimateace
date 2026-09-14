/**
 * AI Receptionist paid add-on — $49.99/month (separate from SaaS + crew seats).
 */
import type Stripe from 'stripe';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { getSubscriptionPeriodEnd } from '@/lib/billing-sync';
import { ensureStripeCustomerForOwner } from '@/lib/crew-billing';

export const RECEPTIONIST_ADDON_AMOUNT_CENTS = 4999;
export const RECEPTIONIST_ADDON_AMOUNT_DISPLAY = '$49.99';
export const RECEPTIONIST_ADDON_PURPOSE = 'receptionist_addon';

export function getReceptionistAddonPriceId(): string {
  return (process.env.STRIPE_PRICE_ID_RECEPTIONIST_ADDON || '').trim();
}

export type ReceptionistBilling = {
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  status?: string | null;
  currentPeriodEnd?: string | null;
  cancelAtPeriodEnd?: boolean;
};

export function isReceptionistAddonSubscription(sub: Stripe.Subscription): boolean {
  return String(sub.metadata?.purpose || '') === RECEPTIONIST_ADDON_PURPOSE;
}

export function receptionistAddonHasAccess(billing: ReceptionistBilling | null | undefined): boolean {
  if (!billing) return false;
  const status = String(billing.status || '').toLowerCase();
  const periodEnd = billing.currentPeriodEnd
    ? new Date(billing.currentPeriodEnd).getTime()
    : 0;
  const now = Date.now();
  if (status === 'active' || status === 'trialing' || status === 'past_due') return true;
  if ((status === 'canceled' || billing.cancelAtPeriodEnd) && periodEnd > now) return true;
  return false;
}

export async function loadReceptionistBilling(userId: string): Promise<ReceptionistBilling> {
  const admin = getSupabaseAdmin();
  if (!admin) return {};
  const { data } = await admin
    .from('estimates')
    .select('profile')
    .eq('id', `SETTINGS-${userId}`)
    .maybeSingle();
  const b = (data?.profile as any)?.receptionistBilling;
  return b && typeof b === 'object' ? (b as ReceptionistBilling) : {};
}

export async function upsertReceptionistAddonFromStripe(
  sub: Stripe.Subscription,
  fallbackUserId?: string | null
): Promise<{ ok: boolean; error?: string }> {
  const admin = getSupabaseAdmin();
  if (!admin) return { ok: false, error: 'No admin' };

  const userId =
    String(sub.metadata?.supabase_user_id || fallbackUserId || '').trim() || null;
  if (!userId) return { ok: false, error: 'Missing supabase_user_id on subscription' };

  const status = String(sub.status || 'incomplete');
  const periodEnd = getSubscriptionPeriodEnd(sub);
  const billing: ReceptionistBilling = {
    stripeCustomerId:
      typeof sub.customer === 'string' ? sub.customer : sub.customer?.id || null,
    stripeSubscriptionId: sub.id,
    status,
    currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
    cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end),
  };
  const active = receptionistAddonHasAccess(billing);

  const sid = `SETTINGS-${userId}`;
  const { data: existing } = await admin.from('estimates').select('profile').eq('id', sid).maybeSingle();
  const prev = (existing?.profile && typeof existing.profile === 'object' ? existing.profile : {}) as any;

  const { error } = await admin.from('estimates').upsert({
    id: sid,
    user_id: userId,
    jobName: '__settings__',
    documentType: 'settings',
    items: [],
    profile: {
      ...prev,
      receptionistBilling: billing,
      aiReceptionistAddonActive: active,
      // If subscription lapsed, turn off live answering flag (keep number config)
      ...(active
        ? {}
        : {
            receptionistConfig: prev.receptionistConfig
              ? { ...prev.receptionistConfig, enabled: false, status: prev.receptionistConfig.twilio?.phoneNumber ? 'disabled' : 'none' }
              : prev.receptionistConfig,
          }),
    },
    updated_at: new Date().toISOString(),
  });

  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export { ensureStripeCustomerForOwner };
