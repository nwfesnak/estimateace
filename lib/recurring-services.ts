/**
 * Client recurring services (mowing, maintenance, etc.)
 * Completely separate from EstimateAce SaaS billing subscriptions.
 */
import type Stripe from 'stripe';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { getStripe, getAppUrl } from '@/lib/stripe-server';
import { getPaymentAccount } from '@/lib/job-payments';
import { createClientActionToken, verifyClientActionToken } from '@/lib/client-action-token';

export type RecurringInterval = 'week' | 'month' | 'year';
export type RecurringStatus = 'draft' | 'link_sent' | 'active' | 'past_due' | 'canceled';

export type RecurringPlan = {
  id: string;
  user_id: string;
  serviceName: string;
  clientName: string;
  clientEmail: string;
  clientPhone: string;
  address: string;
  city: string;
  state: string;
  zipCode: string;
  amount: number;
  interval: RecurringInterval;
  description: string;
  status: RecurringStatus;
  stripeSubscriptionId: string | null;
  stripeCustomerId: string | null;
  lastPaymentAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export function intervalLabel(interval: RecurringInterval): string {
  if (interval === 'week') return 'every week';
  if (interval === 'year') return 'every year';
  return 'every month';
}

export function money(n: number) {
  return `$${Number(n || 0).toFixed(2)}`;
}

function newRecurringId() {
  return `REC-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

function rowToPlan(row: any): RecurringPlan {
  const r = row?.profile?._recurring || {};
  return {
    id: String(row.id),
    user_id: String(row.user_id || ''),
    serviceName: String(r.serviceName || row.jobName || 'Recurring service'),
    clientName: String(r.clientName || ''),
    clientEmail: String(r.clientEmail || (Array.isArray(row.emails) ? row.emails[0] : '') || ''),
    clientPhone: String(r.clientPhone || (Array.isArray(row.phones) ? row.phones[0] : '') || ''),
    address: String(row.address || r.address || ''),
    city: String(row.city || r.city || ''),
    state: String(row.state || r.state || ''),
    zipCode: String(row.zipCode || row.zipcode || r.zipCode || ''),
    amount: Number(r.amount) || 0,
    interval: (r.interval === 'week' || r.interval === 'year' ? r.interval : 'month') as RecurringInterval,
    description: String(r.description || row.terms || ''),
    status: (r.status || 'draft') as RecurringStatus,
    stripeSubscriptionId: r.stripeSubscriptionId || null,
    stripeCustomerId: r.stripeCustomerId || null,
    lastPaymentAt: r.lastPaymentAt || null,
    createdAt: String(row.created_at || row.updated_at || new Date().toISOString()),
    updatedAt: String(row.updated_at || new Date().toISOString()),
  };
}

function planToRow(plan: Partial<RecurringPlan> & { id: string; user_id: string }, existing?: any) {
  const prev = existing?.profile?._recurring || {};
  const profile = {
    ...(existing?.profile || {}),
    _recurring: {
      ...prev,
      serviceName: plan.serviceName ?? prev.serviceName,
      clientName: plan.clientName ?? prev.clientName,
      clientEmail: plan.clientEmail ?? prev.clientEmail,
      clientPhone: plan.clientPhone ?? prev.clientPhone,
      amount: plan.amount ?? prev.amount,
      interval: plan.interval ?? prev.interval ?? 'month',
      description: plan.description ?? prev.description,
      status: plan.status ?? prev.status ?? 'draft',
      stripeSubscriptionId:
        plan.stripeSubscriptionId !== undefined
          ? plan.stripeSubscriptionId
          : prev.stripeSubscriptionId ?? null,
      stripeCustomerId:
        plan.stripeCustomerId !== undefined
          ? plan.stripeCustomerId
          : prev.stripeCustomerId ?? null,
      lastPaymentAt:
        plan.lastPaymentAt !== undefined ? plan.lastPaymentAt : prev.lastPaymentAt ?? null,
      purpose: 'client_recurring', // never SaaS
    },
  };

  return {
    id: plan.id,
    user_id: plan.user_id,
    jobName: plan.serviceName || existing?.jobName || 'Recurring service',
    address: plan.address ?? existing?.address ?? '',
    city: plan.city ?? existing?.city ?? '',
    state: plan.state ?? existing?.state ?? '',
    zipCode: plan.zipCode ?? existing?.zipCode ?? existing?.zipcode ?? '',
    phones: plan.clientPhone ? [plan.clientPhone] : existing?.phones || [],
    emails: plan.clientEmail ? [plan.clientEmail] : existing?.emails || [],
    date: existing?.date || new Date().toISOString().slice(0, 10),
    invoiceNumber: plan.id,
    items: [
      {
        id: 1,
        description: plan.serviceName || prev.serviceName || 'Recurring service',
        qty: 1,
        unit: plan.interval || prev.interval || 'month',
        price: Number(plan.amount ?? prev.amount) || 0,
        total: Number(plan.amount ?? prev.amount) || 0,
      },
    ],
    terms: plan.description ?? existing?.terms ?? '',
    profile,
    documentType: 'recurring_plan',
    documenttype: 'recurring_plan',
    paymentStatus: plan.status === 'active' ? 'active' : plan.status || 'draft',
    amountPaid: 0,
    updated_at: new Date().toISOString(),
  };
}

export async function listRecurringPlans(ownerUserId: string): Promise<RecurringPlan[]> {
  const admin = getSupabaseAdmin();
  if (!admin) return [];

  const { data, error } = await admin
    .from('estimates')
    .select('*')
    .eq('user_id', ownerUserId)
    .or('documentType.eq.recurring_plan,documenttype.eq.recurring_plan')
    .order('updated_at', { ascending: false });

  if (error) {
    // Fallback: fetch and filter client-side (schema may lack documentType filter)
    const { data: all } = await admin
      .from('estimates')
      .select('*')
      .eq('user_id', ownerUserId)
      .like('id', 'REC-%')
      .order('updated_at', { ascending: false });
    return (all || [])
      .filter(
        (r: any) =>
          r.documentType === 'recurring_plan' ||
          r.documenttype === 'recurring_plan' ||
          String(r.id || '').startsWith('REC-')
      )
      .map(rowToPlan);
  }

  return (data || []).map(rowToPlan);
}

export async function getRecurringPlan(
  ownerUserId: string,
  planId: string
): Promise<RecurringPlan | null> {
  const admin = getSupabaseAdmin();
  if (!admin) return null;
  const { data } = await admin
    .from('estimates')
    .select('*')
    .eq('user_id', ownerUserId)
    .eq('id', planId)
    .maybeSingle();
  if (!data) return null;
  if (
    data.documentType !== 'recurring_plan' &&
    data.documenttype !== 'recurring_plan' &&
    !String(data.id).startsWith('REC-')
  ) {
    return null;
  }
  return rowToPlan(data);
}

export async function createRecurringPlan(
  ownerUserId: string,
  input: {
    serviceName: string;
    clientName: string;
    clientEmail: string;
    clientPhone?: string;
    address?: string;
    city?: string;
    state?: string;
    zipCode?: string;
    amount: number;
    interval?: RecurringInterval;
    description?: string;
  }
): Promise<{ ok: true; plan: RecurringPlan } | { ok: false; error: string }> {
  const admin = getSupabaseAdmin();
  if (!admin) return { ok: false, error: 'Server missing SUPABASE_SERVICE_ROLE_KEY' };

  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount < 0.5) {
    return { ok: false, error: 'Amount must be at least $0.50' };
  }
  const serviceName = String(input.serviceName || '').trim();
  if (!serviceName) return { ok: false, error: 'Service name is required (e.g. Monthly lawn mowing)' };

  const id = newRecurringId();
  const row = planToRow({
    id,
    user_id: ownerUserId,
    serviceName,
    clientName: String(input.clientName || '').trim() || 'Client',
    clientEmail: String(input.clientEmail || '').trim(),
    clientPhone: String(input.clientPhone || '').trim(),
    address: String(input.address || '').trim(),
    city: String(input.city || '').trim(),
    state: String(input.state || '').trim(),
    zipCode: String(input.zipCode || '').trim(),
    amount,
    interval: input.interval || 'month',
    description: String(input.description || '').trim(),
    status: 'draft',
  });

  const { error } = await admin.from('estimates').upsert(row, { onConflict: 'id' });
  if (error) {
    // Try minimal columns
    const { error: e2 } = await admin.from('estimates').upsert(
      {
        id,
        user_id: ownerUserId,
        jobName: serviceName,
        invoiceNumber: id,
        documentType: 'recurring_plan',
        profile: row.profile,
        items: row.items,
        emails: row.emails,
        phones: row.phones,
        address: row.address,
        city: row.city,
        state: row.state,
        zipCode: row.zipCode,
        terms: row.terms,
        updated_at: row.updated_at,
      },
      { onConflict: 'id' }
    );
    if (e2) return { ok: false, error: e2.message };
  }

  const plan = await getRecurringPlan(ownerUserId, id);
  if (!plan) return { ok: false, error: 'Created but could not reload plan' };
  return { ok: true, plan };
}

export async function updateRecurringPlan(
  ownerUserId: string,
  planId: string,
  patch: Partial<RecurringPlan>
): Promise<{ ok: true; plan: RecurringPlan } | { ok: false; error: string }> {
  const admin = getSupabaseAdmin();
  if (!admin) return { ok: false, error: 'Server missing SUPABASE_SERVICE_ROLE_KEY' };

  const { data: existing } = await admin
    .from('estimates')
    .select('*')
    .eq('user_id', ownerUserId)
    .eq('id', planId)
    .maybeSingle();
  if (!existing) return { ok: false, error: 'Plan not found' };

  const current = rowToPlan(existing);
  const row = planToRow(
    {
      ...current,
      ...patch,
      id: planId,
      user_id: ownerUserId,
    },
    existing
  );

  const { error } = await admin.from('estimates').upsert(row, { onConflict: 'id' });
  if (error) return { ok: false, error: error.message };

  const plan = await getRecurringPlan(ownerUserId, planId);
  if (!plan) return { ok: false, error: 'Updated but could not reload' };
  return { ok: true, plan };
}

export function buildRecurringClientLink(
  ownerUserId: string,
  planId: string,
  requestUrl?: string
): string {
  const token = createClientActionToken({
    uid: ownerUserId,
    inv: planId,
    typ: 'recurring' as any,
    expDays: 90,
  });
  const appUrl = getAppUrl(requestUrl);
  return `${appUrl}/client/subscribe?token=${encodeURIComponent(token)}`;
}

export function verifyRecurringToken(token: string) {
  const v = verifyClientActionToken(token);
  if (!v.ok) return v;
  // Accept typ recurring or plan ids starting with REC-
  const typ = (v.payload as any).typ;
  if (typ !== 'recurring' && !String(v.payload.inv).startsWith('REC-')) {
    return { ok: false as const, error: 'Not a recurring service link' };
  }
  return v;
}

/**
 * Stripe Checkout in subscription mode for a client recurring plan.
 * Does NOT use SaaS STRIPE_PRICE_ID_* — dynamic price_data only.
 */
export async function createClientRecurringCheckout(input: {
  ownerUserId: string;
  planId: string;
  requestUrl: string;
  clientEmail?: string;
}): Promise<{ ok: boolean; url?: string; mode?: string; error?: string }> {
  const stripe = getStripe();
  if (!stripe) return { ok: false, error: 'Stripe is not configured (STRIPE_SECRET_KEY).' };

  const plan = await getRecurringPlan(input.ownerUserId, input.planId);
  if (!plan) return { ok: false, error: 'Plan not found' };
  if (plan.amount < 0.5) return { ok: false, error: 'Plan amount must be at least $0.50' };

  const cents = Math.round(plan.amount * 100);
  const appUrl = getAppUrl(input.requestUrl);
  const account = await getPaymentAccount(input.ownerUserId);
  const connectedId = account?.stripe_account_id || null;
  const canChargeConnected = !!(connectedId && account?.charges_enabled);

  const token = createClientActionToken({
    uid: input.ownerUserId,
    inv: input.planId,
    typ: 'recurring' as any,
    expDays: 90,
  });
  const returnBase = `${appUrl}/client/subscribe?token=${encodeURIComponent(token)}`;

  const metadata: Record<string, string> = {
    purpose: 'client_recurring_subscription',
    // Explicit: never treat as SaaS
    saas_billing: 'false',
    supabase_user_id: input.ownerUserId,
    recurring_plan_id: input.planId,
    service_name: plan.serviceName.slice(0, 200),
  };

  const productName = `${plan.serviceName}`.slice(0, 120);
  const description = [
    plan.clientName ? `For ${plan.clientName}` : '',
    plan.address,
    plan.description,
  ]
    .filter(Boolean)
    .join(' · ')
    .slice(0, 200);

  const sessionParams: Stripe.Checkout.SessionCreateParams = {
    mode: 'subscription',
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: cents,
          recurring: {
            interval: plan.interval === 'week' ? 'week' : plan.interval === 'year' ? 'year' : 'month',
          },
          product_data: {
            name: productName,
            description: description || `Recurring ${intervalLabel(plan.interval)}`,
          },
        },
      },
    ],
    success_url: `${returnBase}&subscribed=1`,
    cancel_url: `${returnBase}&subscribed=0`,
    metadata,
    subscription_data: {
      metadata,
    },
    payment_method_types: ['card'],
  };

  const email = (input.clientEmail || plan.clientEmail || '').trim();
  if (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    sessionParams.customer_email = email;
  }

  try {
    if (canChargeConnected && connectedId) {
      const session = await stripe.checkout.sessions.create(sessionParams, {
        stripeAccount: connectedId,
      });
      if (!session.url) return { ok: false, error: 'Stripe did not return a checkout URL.' };
      await updateRecurringPlan(input.ownerUserId, input.planId, { status: 'link_sent' });
      return { ok: true, url: session.url, mode: 'connect' };
    }

    const session = await stripe.checkout.sessions.create({
      ...sessionParams,
      metadata: { ...metadata, settle_to: 'platform' },
      subscription_data: {
        metadata: { ...metadata, settle_to: 'platform' },
      },
    });
    if (!session.url) return { ok: false, error: 'Stripe did not return a checkout URL.' };
    await updateRecurringPlan(input.ownerUserId, input.planId, { status: 'link_sent' });
    return { ok: true, url: session.url, mode: 'platform' };
  } catch (e: any) {
    console.error('createClientRecurringCheckout:', e);
    return {
      ok: false,
      error:
        e?.message ||
        'Could not start subscription checkout. Connect Stripe for job payments under Profile → Payments.',
    };
  }
}

/** Webhook: activate plan after client completes subscription checkout */
export async function markRecurringActiveFromCheckout(
  session: Stripe.Checkout.Session
): Promise<{ ok: boolean; error?: string }> {
  if (session.metadata?.purpose !== 'client_recurring_subscription') {
    return { ok: false, error: 'Not a client recurring session' };
  }
  if (session.metadata?.saas_billing === 'true') {
    return { ok: false, error: 'Refusing SaaS-flagged session' };
  }

  const ownerId = String(session.metadata?.supabase_user_id || '').trim();
  const planId = String(session.metadata?.recurring_plan_id || '').trim();
  if (!ownerId || !planId) return { ok: false, error: 'Missing plan metadata' };

  const subRef = session.subscription;
  const subId = typeof subRef === 'string' ? subRef : subRef?.id || null;
  const custRef = session.customer;
  const customerId = typeof custRef === 'string' ? custRef : custRef?.id || null;

  return updateRecurringPlan(ownerId, planId, {
    status: 'active',
    stripeSubscriptionId: subId,
    stripeCustomerId: customerId,
    lastPaymentAt: new Date().toISOString(),
  });
}

/** Cancel Stripe subscription for a client plan (not SaaS). */
export async function cancelClientRecurringSubscription(
  ownerUserId: string,
  planId: string
): Promise<{ ok: boolean; error?: string }> {
  const plan = await getRecurringPlan(ownerUserId, planId);
  if (!plan) return { ok: false, error: 'Plan not found' };

  const stripe = getStripe();
  if (stripe && plan.stripeSubscriptionId) {
    const account = await getPaymentAccount(ownerUserId);
    const connectedId = account?.stripe_account_id || null;
    try {
      const opts =
        connectedId && account?.charges_enabled
          ? ({ stripeAccount: connectedId } as Stripe.RequestOptions)
          : undefined;
      await stripe.subscriptions.cancel(plan.stripeSubscriptionId, undefined, opts);
    } catch (e: any) {
      console.warn('cancel subscription:', e?.message);
      // Still mark canceled locally
    }
  }

  return updateRecurringPlan(ownerUserId, planId, {
    status: 'canceled',
  });
}
