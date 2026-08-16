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
export type RecurringStatus =
  | 'draft'
  | 'link_sent'
  | 'approved'
  | 'active'
  | 'past_due'
  /** Payments stopped but plan stays on Recurring (can turn back on) */
  | 'paused'
  | 'canceled';

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
  /** When client tapped Approve on the email / subscribe page */
  clientApprovedAt: string | null;
  approvalEmailSentAt: string | null;
  companyName: string;
  companyEmail: string;
  companyPhone: string;
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

function firstEmailFromRow(row: any, recurring: any): string {
  const candidates = [
    recurring?.clientEmail,
    Array.isArray(row?.emails) ? row.emails[0] : null,
    typeof row?.emails === 'string' ? row.emails : null,
    row?.email,
    row?.clientEmail,
    row?.client_email,
  ];
  for (const c of candidates) {
    const s = String(c || '')
      .trim()
      .toLowerCase();
    if (s && s.includes('@')) return s;
  }
  return '';
}

function rowToPlan(row: any): RecurringPlan {
  const r = row?.profile?._recurring || {};
  const prof = row?.profile || {};
  return {
    id: String(row.id),
    user_id: String(row.user_id || ''),
    serviceName: String(r.serviceName || row.jobName || 'Recurring service'),
    clientName: String(r.clientName || ''),
    clientEmail: firstEmailFromRow(row, r),
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
    clientApprovedAt: r.clientApprovedAt || null,
    approvalEmailSentAt: r.approvalEmailSentAt || null,
    companyName: String(r.companyName || prof.company || ''),
    companyEmail: String(r.companyEmail || prof.email || ''),
    companyPhone: String(r.companyPhone || prof.phone || ''),
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
      clientApprovedAt:
        plan.clientApprovedAt !== undefined
          ? plan.clientApprovedAt
          : prev.clientApprovedAt ?? null,
      approvalEmailSentAt:
        plan.approvalEmailSentAt !== undefined
          ? plan.approvalEmailSentAt
          : prev.approvalEmailSentAt ?? null,
      companyName: plan.companyName ?? prev.companyName ?? '',
      companyEmail: plan.companyEmail ?? prev.companyEmail ?? '',
      companyPhone: plan.companyPhone ?? prev.companyPhone ?? '',
      purpose: 'client_recurring', // never SaaS
    },
  };

  // Single documentType key only — dual camel/lower keys break some PostgREST schemas
  return {
    id: plan.id,
    user_id: plan.user_id,
    jobName: plan.serviceName || existing?.jobName || existing?.jobname || 'Recurring service',
    address: plan.address ?? existing?.address ?? '',
    city: plan.city ?? existing?.city ?? '',
    state: plan.state ?? existing?.state ?? '',
    zipCode: plan.zipCode ?? existing?.zipCode ?? existing?.zipcode ?? '',
    phones: plan.clientPhone
      ? [plan.clientPhone]
      : Array.isArray(existing?.phones)
        ? existing.phones
        : [],
    emails: plan.clientEmail
      ? [plan.clientEmail]
      : Array.isArray(existing?.emails)
        ? existing.emails
        : [],
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
    paymentStatus:
      plan.status === 'active'
        ? 'active'
        : plan.status === 'paused'
          ? 'paused'
          : plan.status || 'draft',
    amountPaid: Number(existing?.amountPaid ?? existing?.amountpaid) || 0,
    updated_at: new Date().toISOString(),
  };
}

export async function listRecurringPlans(ownerUserId: string): Promise<RecurringPlan[]> {
  const admin = getSupabaseAdmin();
  if (!admin) return [];

  // Include canceled — they live in Recurring → Archive folder (not paid invoices)
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
    companyName?: string;
    companyEmail?: string;
    companyPhone?: string;
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

  const clientEmail = String(input.clientEmail || '')
    .trim()
    .toLowerCase();
  if (clientEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clientEmail)) {
    return { ok: false, error: 'Client email looks invalid. Use a full address like name@email.com' };
  }

  const id = newRecurringId();
  const row = planToRow({
    id,
    user_id: ownerUserId,
    serviceName,
    clientName: String(input.clientName || '').trim() || 'Client',
    clientEmail,
    clientPhone: String(input.clientPhone || '').trim(),
    address: String(input.address || '').trim(),
    city: String(input.city || '').trim(),
    state: String(input.state || '').trim(),
    zipCode: String(input.zipCode || '').trim(),
    amount,
    interval: input.interval || 'month',
    description: String(input.description || '').trim(),
    status: 'draft',
    companyName: String(input.companyName || '').trim(),
    companyEmail: String(input.companyEmail || '').trim(),
    companyPhone: String(input.companyPhone || '').trim(),
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

  const { data: existing, error: loadErr } = await admin
    .from('estimates')
    .select('*')
    .eq('user_id', ownerUserId)
    .eq('id', planId)
    .maybeSingle();
  if (loadErr) return { ok: false, error: loadErr.message };
  if (!existing) {
    // Also try without user filter (id is unique) then verify ownership
    const { data: byId } = await admin.from('estimates').select('*').eq('id', planId).maybeSingle();
    if (!byId) return { ok: false, error: `Plan not found (${planId})` };
    if (String(byId.user_id) !== String(ownerUserId)) {
      return { ok: false, error: 'Plan not found for this account' };
    }
  }

  const rowExisting = existing || (await admin.from('estimates').select('*').eq('id', planId).maybeSingle()).data;
  if (!rowExisting) return { ok: false, error: `Plan not found (${planId})` };

  const current = rowToPlan(rowExisting);
  const merged: Partial<RecurringPlan> & { id: string; user_id: string } = {
    ...current,
    ...patch,
    id: planId,
    user_id: ownerUserId,
  };
  // Never wipe amount to 0 on partial patches
  if (patch.amount == null) merged.amount = current.amount;
  if (patch.clientEmail === undefined) merged.clientEmail = current.clientEmail;

  const fullRow = planToRow(merged, rowExisting);

  // Prefer .update() over upsert so we don't invent columns that fail insert constraints
  const camelUpdate: Record<string, any> = {
    jobName: fullRow.jobName,
    address: fullRow.address,
    city: fullRow.city,
    state: fullRow.state,
    zipCode: fullRow.zipCode,
    phones: fullRow.phones,
    emails: fullRow.emails,
    invoiceNumber: fullRow.invoiceNumber,
    items: fullRow.items,
    terms: fullRow.terms,
    profile: fullRow.profile,
    documentType: 'recurring_plan',
    paymentStatus: fullRow.paymentStatus,
    updated_at: new Date().toISOString(),
  };

  let { error } = await admin
    .from('estimates')
    .update(camelUpdate)
    .eq('id', planId)
    .eq('user_id', ownerUserId);

  if (error) {
    console.warn('recurring update camelCase failed:', error.message);
    // Lowercase column schema (some projects unquote columns)
    const lowerUpdate: Record<string, any> = {
      jobname: fullRow.jobName,
      address: fullRow.address,
      city: fullRow.city,
      state: fullRow.state,
      zipcode: fullRow.zipCode,
      phones: fullRow.phones,
      emails: fullRow.emails,
      invoicenumber: fullRow.invoiceNumber,
      items: fullRow.items,
      terms: fullRow.terms,
      profile: fullRow.profile,
      documenttype: 'recurring_plan',
      paymentstatus: fullRow.paymentStatus,
      updated_at: new Date().toISOString(),
    };
    const retry = await admin
      .from('estimates')
      .update(lowerUpdate)
      .eq('id', planId)
      .eq('user_id', ownerUserId);
    error = retry.error;
  }

  if (error) {
    console.warn('recurring update lowercase failed:', error.message);
    // Minimal: only profile + emails (always present as JSONB / array)
    const minimal = await admin
      .from('estimates')
      .update({
        profile: fullRow.profile,
        emails: fullRow.emails,
        phones: fullRow.phones,
        terms: fullRow.terms,
        items: fullRow.items,
        updated_at: new Date().toISOString(),
      })
      .eq('id', planId)
      .eq('user_id', ownerUserId);
    if (minimal.error) {
      return {
        ok: false,
        error: minimal.error.message || error.message || 'Could not save plan changes',
      };
    }
  }

  const plan = await getRecurringPlan(ownerUserId, planId);
  if (!plan) {
    // Return merged view even if reload filter fails
    return { ok: true, plan: { ...current, ...merged, id: planId, user_id: ownerUserId } as RecurringPlan };
  }
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

  const { computeStripeCardFee } = await import('@/lib/stripe-fees');
  const fee = computeStripeCardFee(plan.amount);
  const serviceCents = Math.round(plan.amount * 100);
  const feeCents = Math.round(fee.feeAmount * 100);
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

  const interval =
    plan.interval === 'week' ? 'week' : plan.interval === 'year' ? 'year' : 'month';

  const metadata: Record<string, string> = {
    purpose: 'client_recurring_subscription',
    // Explicit: never treat as SaaS
    saas_billing: 'false',
    supabase_user_id: input.ownerUserId,
    recurring_plan_id: input.planId,
    service_name: plan.serviceName.slice(0, 200),
    base_amount: plan.amount.toFixed(2),
    fee_amount: fee.feeAmount.toFixed(2),
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

  const line_items: Stripe.Checkout.SessionCreateParams.LineItem[] = [
    {
      quantity: 1,
      price_data: {
        currency: 'usd',
        unit_amount: serviceCents,
        recurring: { interval },
        product_data: {
          name: productName,
          description: description || `Recurring ${intervalLabel(plan.interval)}`,
        },
      },
    },
  ];
  if (feeCents > 0) {
    line_items.push({
      quantity: 1,
      price_data: {
        currency: 'usd',
        unit_amount: feeCents,
        recurring: { interval },
        product_data: {
          name: fee.feeLabel,
          description: fee.feeDescription.slice(0, 200),
        },
      },
    });
  }

  const sessionParams: Stripe.Checkout.SessionCreateParams = {
    mode: 'subscription',
    line_items,
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
      // Don't downgrade approved/active status when opening checkout
      if (plan.status === 'draft' || plan.status === 'link_sent') {
        await updateRecurringPlan(input.ownerUserId, input.planId, { status: 'link_sent' });
      }
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
    if (plan.status === 'draft' || plan.status === 'link_sent') {
      await updateRecurringPlan(input.ownerUserId, input.planId, { status: 'link_sent' });
    }
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

/**
 * Email (and SMS when phone is on file) the contractor when a client
 * approves recurring charges or finishes card / payment setup.
 */
async function notifyContractorRecurringEvent(
  plan: RecurringPlan,
  event: 'approved' | 'payment_setup'
): Promise<void> {
  try {
    const { sendEmailNotification, sendSmsNotification } = await import('@/lib/notifications');
    const to = String(plan.companyEmail || '').trim().toLowerCase();
    const phone = String(plan.companyPhone || '').trim();
    const client = plan.clientName || plan.clientEmail || 'A client';
    const service = plan.serviceName || 'Recurring service';
    const amt = `${money(plan.amount)} ${intervalLabel(plan.interval)}`;
    const where = [plan.address, plan.city, plan.state, plan.zipCode].filter(Boolean).join(', ');

    const subject =
      event === 'approved'
        ? `Recurring approved: ${client} — ${service}`
        : `Recurring payment set up: ${client} — ${service}`;

    const text =
      event === 'approved'
        ? [
            `${client} approved recurring charges.`,
            ``,
            `Service: ${service}`,
            `Amount: ${amt}`,
            where ? `Address: ${where}` : '',
            plan.clientEmail ? `Client email: ${plan.clientEmail}` : '',
            plan.clientPhone ? `Client phone: ${plan.clientPhone}` : '',
            `Plan: ${plan.id}`,
            ``,
            `Open EstimateAce → Recurring charges to review. They still need to finish payment setup if not already active.`,
          ]
            .filter((l) => l !== '')
            .join('\n')
        : [
            `${client} finished setting up payment for a recurring service.`,
            ``,
            `Service: ${service}`,
            `Amount: ${amt}`,
            where ? `Address: ${where}` : '',
            plan.clientEmail ? `Client email: ${plan.clientEmail}` : '',
            plan.clientPhone ? `Client phone: ${plan.clientPhone}` : '',
            `Plan: ${plan.id}`,
            `Status: Active — billing can collect on schedule.`,
            ``,
            `Open EstimateAce → Recurring charges to manage the plan.`,
          ]
            .filter((l) => l !== '')
            .join('\n');

    const smsBody =
      event === 'approved'
        ? `EstimateAce: ${client} approved recurring "${service}" (${amt}). Open Recurring charges.`
        : `EstimateAce: ${client} set up payment for "${service}" (${amt}). Plan is active.`;

    if (to && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      const result = await sendEmailNotification(to, subject, text, {
        // Platform From — contractor is the recipient
        from:
          (process.env.NOTIFICATION_FROM_EMAIL || '').trim() ||
          'EstimateAce <notifications@estimateace.com>',
      });
      if (!result.ok) {
        console.warn('notify contractor recurring email:', result.error);
      }
    } else {
      console.warn(
        'notify contractor recurring: no company email on plan — set company email on the plan or profile when creating it'
      );
    }

    if (phone.replace(/\D/g, '').length >= 10) {
      const sms = await sendSmsNotification(phone, smsBody);
      if (!sms.ok) {
        console.warn('notify contractor recurring SMS:', sms.error);
      }
    }
  } catch (e: any) {
    console.warn('notifyContractorRecurringEvent:', e?.message || e);
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

  const existing = await getRecurringPlan(ownerId, planId);
  const alreadyActive =
    existing?.status === 'active' && !!existing.stripeSubscriptionId;

  const subRef = session.subscription;
  const subId = typeof subRef === 'string' ? subRef : subRef?.id || null;
  const custRef = session.customer;
  const customerId = typeof custRef === 'string' ? custRef : custRef?.id || null;

  const updated = await updateRecurringPlan(ownerId, planId, {
    status: 'active',
    stripeSubscriptionId: subId,
    stripeCustomerId: customerId,
    lastPaymentAt: new Date().toISOString(),
    // Ensure approval timestamp if they went straight to checkout
    clientApprovedAt: existing?.clientApprovedAt || new Date().toISOString(),
  });

  if (updated.ok && !alreadyActive && updated.plan) {
    // Fire-and-forget — never fail the webhook because email/SMS failed
    void notifyContractorRecurringEvent(updated.plan, 'payment_setup');
  }

  return updated.ok ? { ok: true } : { ok: false, error: updated.error };
}

/** Client tapped Approve — records consent before card setup. */
export async function markClientApprovedRecurring(
  ownerUserId: string,
  planId: string
): Promise<{ ok: true; plan: RecurringPlan } | { ok: false; error: string }> {
  const plan = await getRecurringPlan(ownerUserId, planId);
  if (!plan) return { ok: false, error: 'Plan not found' };
  if (plan.status === 'canceled') {
    return { ok: false, error: 'This plan was canceled. Contact your contractor.' };
  }
  if (plan.status === 'active') {
    return { ok: true, plan };
  }

  // Only notify once — skip re-approvals / webhook retries
  const firstApproval = !plan.clientApprovedAt && plan.status !== 'approved';

  const now = new Date().toISOString();
  const updated = await updateRecurringPlan(ownerUserId, planId, {
    status: 'approved',
    clientApprovedAt: plan.clientApprovedAt || now,
  });

  if (updated.ok && firstApproval && updated.plan) {
    void notifyContractorRecurringEvent(updated.plan, 'approved');
  }

  return updated;
}

/**
 * Send client recurring approval via email + SMS (phone on file).
 * Uses Resend for email; Twilio for SMS when configured.
 */
export async function sendRecurringApprovalEmail(input: {
  ownerUserId: string;
  planId: string;
  requestUrl?: string;
  companyName?: string;
  companyEmail?: string;
  companyPhone?: string;
  /** Optional override if UI has a fresher email than the stored plan */
  clientEmail?: string;
  /** Optional override for SMS */
  clientPhone?: string;
}): Promise<{
  ok: boolean;
  error?: string;
  clientLink?: string;
  resendId?: string;
  to?: string;
  smsTo?: string;
  emailSent?: boolean;
  smsSent?: boolean;
}> {
  const admin = getSupabaseAdmin();
  if (!admin) {
    return {
      ok: false,
      error:
        'Server missing SUPABASE_SERVICE_ROLE_KEY — cannot load the plan to email. Add it in Vercel and redeploy.',
    };
  }

  let plan = await getRecurringPlan(input.ownerUserId, input.planId);
  // Loose fallback: load by id only (older rows may lack documentType)
  if (!plan) {
    const { data } = await admin
      .from('estimates')
      .select('*')
      .eq('user_id', input.ownerUserId)
      .eq('id', input.planId)
      .maybeSingle();
    if (data) plan = rowToPlan(data);
  }
  if (!plan) {
    return {
      ok: false,
      error: `Plan not found (${input.planId}). Refresh Recurring Charges and try again.`,
    };
  }

  // Prefer explicit override from the send request, then plan storage
  const rawTo = String(input.clientEmail || plan.clientEmail || '')
    .trim()
    .replace(/\s+/g, '')
    .toLowerCase();
  // Strip accidental mailto: prefixes from paste
  const to = rawTo.replace(/^mailto:/i, '');
  const hasEmail = !!(to && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to));

  const phoneRaw = String(input.clientPhone || plan.clientPhone || '').trim();
  const hasPhone = !!phoneRaw && phoneRaw.replace(/\D/g, '').length >= 10;

  const clientLink = buildRecurringClientLink(
    input.ownerUserId,
    input.planId,
    input.requestUrl
  );

  if (!hasEmail && !hasPhone) {
    return {
      ok: false,
      error:
        'Add a client email and/or phone on the plan before sending approval.',
      clientLink,
    };
  }

  // Persist contact onto the plan so reloads / re-sends work
  const patch: Partial<RecurringPlan> = {};
  if (hasEmail) patch.clientEmail = to;
  if (hasPhone) patch.clientPhone = phoneRaw;
  if (input.companyName) patch.companyName = input.companyName;
  if (input.companyEmail) patch.companyEmail = input.companyEmail;
  if (input.companyPhone) patch.companyPhone = input.companyPhone;
  if (Object.keys(patch).length) {
    await updateRecurringPlan(input.ownerUserId, input.planId, patch);
  }

  const fresh = (await getRecurringPlan(input.ownerUserId, input.planId)) || plan;
  const company = (input.companyName || fresh.companyName || 'Your contractor').trim() || 'Your contractor';
  const companyEmail = (input.companyEmail || fresh.companyEmail || '').trim();
  const companyPhone = (input.companyPhone || fresh.companyPhone || '').trim();
  const interval = intervalLabel(fresh.interval);
  const amt = money(fresh.amount);
  const location = [fresh.address, fresh.city, fresh.state, fresh.zipCode]
    .filter(Boolean)
    .join(', ');

  const escape = (s: string) =>
    String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  const subject = `${company}: please approve recurring ${fresh.serviceName} — ${amt} ${interval}`;

  const text = [
    `${company} is asking you to approve a recurring service charge.`,
    '',
    `Service: ${fresh.serviceName}`,
    fresh.clientName ? `Client: ${fresh.clientName}` : '',
    location ? `Address: ${location}` : '',
    `Amount: ${amt} ${interval}`,
    fresh.description ? `Details:\n${fresh.description}` : '',
    '',
    'Approve and set up payment here:',
    clientLink,
    '',
    companyPhone ? `Questions? Call ${companyPhone}` : '',
    companyEmail ? `Email ${companyEmail}` : '',
    '',
    'This is a charge from your contractor for their service — not EstimateAce software.',
  ]
    .filter((l) => l !== '')
    .join('\n');

  const html = `<!DOCTYPE html>
<html><body style="font-family:system-ui,Segoe UI,sans-serif;color:#0f172a;line-height:1.5;max-width:560px;margin:0 auto;padding:24px;">
  <h1 style="font-size:22px;margin:0 0 8px;">Approve recurring charges</h1>
  <p style="color:#64748b;margin:0 0 20px;">From <strong>${escape(company)}</strong></p>
  <div style="background:#f0fdfa;border:2px solid #14b8a6;border-radius:16px;padding:20px;margin:16px 0;">
    <p style="margin:0 0 6px;font-size:18px;font-weight:700;">${escape(fresh.serviceName)}</p>
    ${fresh.clientName ? `<p style="margin:0 0 4px;color:#475569;">Client: ${escape(fresh.clientName)}</p>` : ''}
    ${location ? `<p style="margin:0 0 4px;color:#475569;">${escape(location)}</p>` : ''}
    <p style="margin:12px 0 0;font-size:24px;font-weight:800;color:#0f766e;">${escape(amt)} <span style="font-size:14px;font-weight:600;">${escape(interval)}</span></p>
    ${
      fresh.description
        ? `<p style="margin:12px 0 0;font-size:13px;color:#334155;white-space:pre-wrap;">${escape(fresh.description.slice(0, 1500))}</p>`
        : ''
    }
  </div>
  <p style="font-size:14px;color:#334155;">By approving, you agree to this recurring service charge. You can set up a card on the next screen so payments run automatically.</p>
  <div style="text-align:center;margin:28px 0;">
    <a href="${escape(clientLink)}"
       style="display:inline-block;background:#0f766e;color:#ffffff;text-decoration:none;font-weight:700;font-size:16px;padding:16px 32px;border-radius:12px;">
      ✓ Approve recurring charges
    </a>
  </div>
  <p style="font-size:12px;color:#64748b;text-align:center;">Or open this link:<br/>
    <a href="${escape(clientLink)}" style="color:#0f766e;word-break:break-all;">${escape(clientLink)}</a>
  </p>
  <p style="margin-top:24px;font-size:13px;color:#475569;">
    Questions? ${companyPhone ? `Call ${escape(companyPhone)}` : ''}${companyPhone && companyEmail ? ' · ' : ''}${companyEmail ? `Email ${escape(companyEmail)}` : ''}
  </p>
  <p style="font-size:11px;color:#94a3b8;margin-top:28px;">This emails you about a service from your contractor — not an EstimateAce software subscription.</p>
</body></html>`;

  const { sendEmailNotification, sendSmsNotification } = await import('@/lib/notifications');
  const replyTo =
    companyEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(companyEmail) ? companyEmail : undefined;

  // Use verified platform From first (most reliable). Company name is in the body/subject.
  const platformFrom =
    (process.env.NOTIFICATION_FROM_EMAIL || '').trim() ||
    'EstimateAce <notifications@estimateace.com>';

  let emailSent = false;
  let resendId: string | undefined;
  let emailError: string | undefined;

  if (hasEmail) {
    let result = await sendEmailNotification(to, subject, text, {
      html,
      from: platformFrom,
      replyTo,
    });

    if (!result.ok) {
      console.error('[recurring email] platform From failed:', result.error);
      result = await sendEmailNotification(to, subject, text, {
        html,
        from: 'EstimateAce <notifications@estimateace.com>',
      });
    }

    if (result.ok) {
      emailSent = true;
      resendId = result.id;
    } else {
      emailError = result.error || 'Email failed';
      console.error('[recurring email] all attempts failed:', emailError);
    }
  }

  // Always try SMS to phone on file when present
  let smsSent = false;
  let smsError: string | undefined;
  let smsTo: string | undefined;
  if (hasPhone) {
    const smsBody = [
      `${company}: please approve recurring ${fresh.serviceName} — ${amt} ${interval}.`,
      `Approve here: ${clientLink}`,
      companyPhone ? `Questions? Call ${companyPhone}` : '',
    ]
      .filter(Boolean)
      .join(' ');
    const smsResult = await sendSmsNotification(phoneRaw, smsBody);
    if (smsResult.ok) {
      smsSent = true;
      smsTo = phoneRaw;
    } else {
      smsError = smsResult.error || 'SMS failed';
      console.warn('[recurring sms] failed:', smsError);
    }
  }

  if (!emailSent && !smsSent) {
    const parts = [
      emailError || (hasEmail ? null : 'No client email on plan'),
      smsError || (hasPhone ? null : 'No client phone on plan'),
    ].filter(Boolean);
    return {
      ok: false,
      error:
        parts.join(' · ') +
        ' Client approval link is available to copy. For SMS, Twilio must be configured (TWILIO_* env).',
      clientLink,
      to: hasEmail ? to : undefined,
      smsTo: hasPhone ? phoneRaw : undefined,
      emailSent: false,
      smsSent: false,
    };
  }

  await updateRecurringPlan(input.ownerUserId, input.planId, {
    status: fresh.status === 'active' || fresh.status === 'approved' ? fresh.status : 'link_sent',
    approvalEmailSentAt: new Date().toISOString(),
    ...(hasEmail ? { clientEmail: to } : {}),
    ...(hasPhone ? { clientPhone: phoneRaw } : {}),
  });

  return {
    ok: true,
    clientLink,
    resendId,
    to: emailSent ? to : undefined,
    smsTo: smsSent ? phoneRaw : undefined,
    emailSent,
    smsSent,
  };
}

/**
 * Cancel a client recurring plan (not SaaS).
 * Stays on Recurring Charges under the Archive folder — does NOT go to paid invoices.
 * Invoices are separate: they stay as invoices and only move to Paid invoices when paid.
 */
export async function cancelClientRecurringSubscription(
  ownerUserId: string,
  planId: string
): Promise<{ ok: boolean; error?: string; plan?: RecurringPlan | null }> {
  const plan = await getRecurringPlan(ownerUserId, planId);
  if (!plan) return { ok: false, error: 'Plan not found' };
  if (plan.status === 'canceled') {
    return { ok: true, plan };
  }

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

  const updated = await updateRecurringPlan(ownerUserId, planId, {
    status: 'canceled',
    stripeSubscriptionId: null,
  });
  if (!updated.ok) return { ok: false, error: updated.error, plan };
  return { ok: true, plan: updated.plan };
}

/**
 * Move a canceled plan out of Recurring Archive back to draft (can re-send approval).
 */
export async function restoreCanceledRecurringInPlace(
  ownerUserId: string,
  planId: string
): Promise<{ ok: boolean; error?: string; plan?: RecurringPlan }> {
  const plan = await getRecurringPlan(ownerUserId, planId);
  if (!plan) return { ok: false, error: 'Plan not found' };
  if (plan.status !== 'canceled') {
    return { ok: true, plan };
  }
  const updated = await updateRecurringPlan(ownerUserId, planId, {
    status: 'draft',
    clientApprovedAt: null,
    approvalEmailSentAt: null,
    stripeSubscriptionId: null,
  });
  if (!updated.ok) return { ok: false, error: updated.error };
  return { ok: true, plan: updated.plan };
}

/**
 * Permanently delete a plan that is already in Recurring → Archive (status canceled).
 * Active / paused plans must be canceled first.
 */
export async function deleteArchivedRecurringPlan(
  ownerUserId: string,
  planId: string
): Promise<{ ok: boolean; error?: string }> {
  const admin = getSupabaseAdmin();
  if (!admin) return { ok: false, error: 'Server missing SUPABASE_SERVICE_ROLE_KEY' };

  const id = String(planId || '').trim();
  if (!id) return { ok: false, error: 'Plan id is required' };

  const plan = await getRecurringPlan(ownerUserId, id);
  if (!plan) return { ok: false, error: 'Plan not found' };
  if (plan.status !== 'canceled') {
    return {
      ok: false,
      error: 'Only archived (canceled) plans can be deleted. Cancel the plan first.',
    };
  }

  // Best-effort: cancel any leftover Stripe subscription before hard delete
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
      console.warn('delete archived recurring — stripe cancel:', e?.message);
    }
  }

  const { error: delErr } = await admin
    .from('estimates')
    .delete()
    .eq('id', id)
    .eq('user_id', ownerUserId);

  if (delErr) {
    return { ok: false, error: delErr.message || 'Could not delete archived plan' };
  }

  // Clean up any legacy INV-REC archive row tied to this plan
  const rest = id.replace(/^REC-/i, '');
  const legacyIds = [`INV-REC-${rest}`, id].filter(Boolean);
  for (const archId of legacyIds) {
    try {
      await admin.from('archive-est').delete().eq('id', archId).eq('user_id', ownerUserId);
    } catch {
      /* optional cleanup */
    }
  }

  return { ok: true };
}

/**
 * Turn off recurring payments (pause Stripe collection if any).
 * Plan stays on Recurring Charges under "Payments off".
 */
export async function pauseClientRecurringPayments(
  ownerUserId: string,
  planId: string
): Promise<{ ok: boolean; error?: string; plan?: RecurringPlan }> {
  const plan = await getRecurringPlan(ownerUserId, planId);
  if (!plan) {
    return {
      ok: false,
      error: `Plan not found (${planId}). Refresh the page — it may already be archived or deleted.`,
    };
  }
  if (plan.status === 'canceled') {
    return { ok: false, error: 'This plan was canceled. Restore it from Archive first.' };
  }
  if (plan.status === 'paused') {
    return { ok: true, plan }; // already off
  }

  const stripe = getStripe();
  if (stripe && plan.stripeSubscriptionId) {
    const account = await getPaymentAccount(ownerUserId);
    const connectedId = account?.stripe_account_id || null;
    try {
      const opts =
        connectedId && account?.charges_enabled
          ? ({ stripeAccount: connectedId } as Stripe.RequestOptions)
          : undefined;
      await stripe.subscriptions.update(
        plan.stripeSubscriptionId,
        { pause_collection: { behavior: 'void' } },
        opts
      );
    } catch (e: any) {
      console.warn('pause subscription:', e?.message);
      // Still mark paused locally even if Stripe pause fails (draft plans have no sub)
    }
  }

  const updated = await updateRecurringPlan(ownerUserId, planId, { status: 'paused' });
  if (!updated.ok) return { ok: false, error: updated.error };
  return { ok: true, plan: updated.plan };
}

/**
 * Turn recurring payments back on (resume Stripe collection if any).
 */
export async function resumeClientRecurringPayments(
  ownerUserId: string,
  planId: string
): Promise<{ ok: boolean; error?: string; plan?: RecurringPlan }> {
  const plan = await getRecurringPlan(ownerUserId, planId);
  if (!plan) return { ok: false, error: 'Plan not found' };
  if (plan.status === 'canceled') {
    return {
      ok: false,
      error: 'Canceled plans are in Recurring Archive. Use Restore to re-activate, then turn payments on.',
    };
  }

  const stripe = getStripe();
  if (stripe && plan.stripeSubscriptionId) {
    const account = await getPaymentAccount(ownerUserId);
    const connectedId = account?.stripe_account_id || null;
    try {
      const opts =
        connectedId && account?.charges_enabled
          ? ({ stripeAccount: connectedId } as Stripe.RequestOptions)
          : undefined;
      // Empty string clears pause_collection in Stripe API
      await stripe.subscriptions.update(
        plan.stripeSubscriptionId,
        { pause_collection: '' as any },
        opts
      );
    } catch (e: any) {
      console.warn('resume subscription:', e?.message);
    }
  }

  // If they had an active sub before, mark active; otherwise draft so they can re-send approval
  const nextStatus: RecurringStatus =
    plan.stripeSubscriptionId || plan.clientApprovedAt ? 'active' : 'draft';

  const updated = await updateRecurringPlan(ownerUserId, planId, { status: nextStatus });
  if (!updated.ok) return { ok: false, error: updated.error };
  return { ok: true, plan: updated.plan };
}

/**
 * True when an archive-est row is a legacy canceled recurring plan filed as INV-REC-*.
 * New cancels stay as REC-* under Recurring → Archive; this only matches old data.
 */
export function isArchivedCanceledRecurringRow(row: any): boolean {
  if (!row) return false;
  const id = String(row.id || '');
  const inv = String(row.invoiceNumber ?? row.invoicenumber ?? '');
  if (/^INV-REC-/i.test(id) || /^INV-REC-/i.test(inv)) return true;
  const rec = row.profile?._recurring;
  if (rec && (rec.purpose === 'client_recurring' || rec.originalPlanId)) {
    return String(rec.status || '').toLowerCase() === 'canceled' || !!rec.originalPlanId;
  }
  return false;
}

function archiveIdToRecurringPlanId(archiveRow: any): string {
  const rec = archiveRow?.profile?._recurring || {};
  if (rec.originalPlanId && String(rec.originalPlanId).trim()) {
    return String(rec.originalPlanId).trim();
  }
  const id = String(archiveRow?.id || '');
  if (/^INV-REC-/i.test(id)) {
    return `REC-${id.replace(/^INV-REC-/i, '')}`;
  }
  return id.startsWith('REC-') ? id : `REC-${id}`;
}

/**
 * Legacy: restore a canceled recurring plan that was filed as INV-REC-* in archive-est.
 * Prefer restoreCanceledRecurringInPlace for new cancels (status stays on REC-*).
 */
export async function restoreRecurringPlanFromArchive(
  ownerUserId: string,
  archiveId: string
): Promise<{ ok: boolean; error?: string; plan?: RecurringPlan; planId?: string }> {
  const admin = getSupabaseAdmin();
  if (!admin) return { ok: false, error: 'Server missing SUPABASE_SERVICE_ROLE_KEY' };

  const id = String(archiveId || '').trim();
  if (!id) return { ok: false, error: 'archiveId is required' };

  const { data: arch, error: loadErr } = await admin
    .from('archive-est')
    .select('*')
    .eq('user_id', ownerUserId)
    .eq('id', id)
    .maybeSingle();

  if (loadErr) return { ok: false, error: loadErr.message };
  if (!arch) return { ok: false, error: 'Archived plan not found' };
  if (!isArchivedCanceledRecurringRow(arch)) {
    return {
      ok: false,
      error: 'This archive is not a canceled recurring plan (expected INV-REC-…).',
    };
  }

  const planId = archiveIdToRecurringPlanId(arch);
  const rec = (arch.profile && typeof arch.profile === 'object'
    ? (arch.profile as any)._recurring
    : {}) || {};

  // Prefer stored recurring fields; fall back to archive row
  const serviceName = String(
    rec.serviceName ||
      String(arch.jobName || arch.jobname || '')
        .replace(/\s*\(canceled\)\s*$/i, '')
        .trim() ||
      'Recurring service'
  );
  const clientEmail = String(
    rec.clientEmail ||
      (Array.isArray(arch.emails) ? arch.emails[0] : '') ||
      ''
  ).trim();
  const clientName = String(rec.clientName || 'Client').trim() || 'Client';
  const clientPhone = String(
    rec.clientPhone || (Array.isArray(arch.phones) ? arch.phones[0] : '') || ''
  ).trim();
  const amount = Number(rec.amount ?? arch.items?.[0]?.price ?? arch.items?.[0]?.total) || 0;
  const interval =
    rec.interval === 'week' || rec.interval === 'year' || rec.interval === 'month'
      ? rec.interval
      : 'month';

  // Strip cancel notes from terms
  let description = String(rec.description || arch.terms || '');
  description = description
    .replace(/\n*\[Canceled recurring plan[^\]]*\]\s*/gi, '')
    .trim();

  const now = new Date().toISOString();
  const row = planToRow(
    {
      id: planId,
      user_id: ownerUserId,
      serviceName,
      clientName,
      clientEmail,
      clientPhone,
      address: String(arch.address || ''),
      city: String(arch.city || ''),
      state: String(arch.state || ''),
      zipCode: String(arch.zipCode || arch.zipcode || ''),
      amount: amount >= 0.5 ? amount : 0.5,
      interval,
      description,
      status: 'draft',
      stripeSubscriptionId: null, // was canceled; client must re-subscribe
      stripeCustomerId: rec.stripeCustomerId || null,
      lastPaymentAt: rec.lastPaymentAt || null,
      clientApprovedAt: null,
      approvalEmailSentAt: null,
      companyName: String(rec.companyName || ''),
      companyEmail: String(rec.companyEmail || ''),
      companyPhone: String(rec.companyPhone || ''),
    },
    {
      ...arch,
      profile: {
        ...(arch.profile && typeof arch.profile === 'object' ? arch.profile : {}),
        _recurring: {
          ...rec,
          status: 'draft',
          restoredAt: now,
          restoredFromArchiveId: id,
        },
      },
    }
  );

  // Ensure active row is a recurring plan (not invoice)
  row.documentType = 'recurring_plan';
  row.paymentStatus = 'draft';
  row.invoiceNumber = planId;
  row.updated_at = now;
  row.jobName = serviceName;

  // If a leftover REC row exists, replace it
  await admin.from('estimates').delete().eq('id', planId).eq('user_id', ownerUserId);

  let { error: insErr } = await admin.from('estimates').upsert(row, { onConflict: 'id' });
  if (insErr) {
    const lower: Record<string, any> = {};
    for (const [k, v] of Object.entries(row)) {
      if (k === 'id' || k === 'user_id' || k === 'updated_at') lower[k] = v;
      else lower[k.toLowerCase()] = v;
    }
    const retry = await admin.from('estimates').upsert(lower, { onConflict: 'id' });
    insErr = retry.error;
  }
  if (insErr) {
    return { ok: false, error: insErr.message || 'Could not restore plan to Recurring' };
  }

  // Remove legacy INV-REC archive row
  const { error: delArch } = await admin
    .from('archive-est')
    .delete()
    .eq('id', id)
    .eq('user_id', ownerUserId);
  if (delArch) {
    console.warn('Restored recurring plan but legacy archive delete failed:', delArch);
  }

  const plan = await getRecurringPlan(ownerUserId, planId);
  if (!plan) {
    return {
      ok: true,
      planId,
      error: 'Restored, but could not reload plan — open Recurring Charges to confirm.',
    };
  }
  return { ok: true, plan, planId };
}
