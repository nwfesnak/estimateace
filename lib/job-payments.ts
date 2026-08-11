import type Stripe from 'stripe';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { getStripe, getAppUrl, getStripeMode } from '@/lib/stripe-server';
import { computeStripeCardFee, shouldPassProcessingFeeToPayee } from '@/lib/stripe-fees';

export type PaymentAccountRow = {
  user_id: string;
  stripe_account_id: string | null;
  charges_enabled: boolean;
  payouts_enabled: boolean;
  details_submitted: boolean;
  account_type: string;
};

export async function getPaymentAccount(userId: string): Promise<PaymentAccountRow | null> {
  const admin = getSupabaseAdmin();
  if (!admin) return null;
  const { data, error } = await admin
    .from('payment_accounts')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) {
    console.warn('payment_accounts read:', error.message);
    return null;
  }
  return data as PaymentAccountRow | null;
}

export async function upsertPaymentAccount(
  userId: string,
  patch: Partial<PaymentAccountRow>
): Promise<{ ok: boolean; error?: string }> {
  const admin = getSupabaseAdmin();
  if (!admin) return { ok: false, error: 'Missing SUPABASE_SERVICE_ROLE_KEY' };
  const { error } = await admin.from('payment_accounts').upsert(
    {
      user_id: userId,
      ...patch,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' }
  );
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/** Refresh Connect account flags from Stripe */
export async function syncConnectAccountStatus(userId: string): Promise<{
  ok: boolean;
  account: PaymentAccountRow | null;
  error?: string;
}> {
  const stripe = getStripe();
  if (!stripe) return { ok: false, account: null, error: 'Stripe not configured' };

  const existing = await getPaymentAccount(userId);
  if (!existing?.stripe_account_id) {
    return { ok: true, account: existing };
  }

  try {
    const acct = await stripe.accounts.retrieve(existing.stripe_account_id);
    const row: Partial<PaymentAccountRow> = {
      stripe_account_id: acct.id,
      charges_enabled: !!acct.charges_enabled,
      payouts_enabled: !!acct.payouts_enabled,
      details_submitted: !!acct.details_submitted,
      account_type: 'express',
    };
    await upsertPaymentAccount(userId, row);
    const updated = await getPaymentAccount(userId);
    return { ok: true, account: updated };
  } catch (e: any) {
    return { ok: false, account: existing, error: e?.message || 'Could not sync Stripe account' };
  }
}

export async function createConnectOnboardingLink(
  userId: string,
  email: string | undefined,
  requestUrl: string
): Promise<{ ok: boolean; url?: string; error?: string }> {
  const stripe = getStripe();
  if (!stripe) return { ok: false, error: 'Stripe is not configured (STRIPE_SECRET_KEY).' };

  const appUrl = getAppUrl(requestUrl);
  let accountId = (await getPaymentAccount(userId))?.stripe_account_id || null;

  if (!accountId) {
    try {
      const account = await stripe.accounts.create({
        type: 'express',
        email: email || undefined,
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
        metadata: {
          supabase_user_id: userId,
          purpose: 'job_payments',
        },
      });
      accountId = account.id;
      await upsertPaymentAccount(userId, {
        stripe_account_id: accountId,
        charges_enabled: false,
        payouts_enabled: false,
        details_submitted: false,
        account_type: 'express',
      });
    } catch (e: any) {
      console.error('Connect account create:', e);
      return {
        ok: false,
        error:
          e?.message ||
          'Could not create Stripe Connect account. Enable Connect in Stripe Dashboard → Connect.',
      };
    }
  }

  try {
    const link = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: `${appUrl}/?stripe_connect=refresh`,
      return_url: `${appUrl}/?stripe_connect=return`,
      type: 'account_onboarding',
    });
    return { ok: true, url: link.url };
  } catch (e: any) {
    console.error('Connect account link:', e);
    return {
      ok: false,
      error: e?.message || 'Could not start Stripe onboarding.',
    };
  }
}

export type JobCheckoutInput = {
  ownerUserId: string;
  amount: number;
  invoiceId: string;
  invoiceNumber: string;
  documentType: string;
  jobName?: string;
  clientEmail?: string;
  requestUrl: string;
  /** Optional return URLs (e.g. client approve page) */
  successUrl?: string;
  cancelUrl?: string;
  /** deposit | balance | invoice */
  paymentKind?: string;
  /**
   * Pass Stripe card processing fee to the payee as a separate line item.
   * Default true. Fee shown clearly on Checkout.
   */
  passProcessingFee?: boolean;
  /** Fee % (default 2.9 Stripe US card). Contractor profile may pass 3 etc. */
  feePercentRate?: number;
  /** Fixed fee dollars (default $0.30) */
  feeFixedUsd?: number;
};

/**
 * Create Stripe Checkout for a job invoice.
 * Prefer Connect Express account; fallback to platform account (money to platform).
 */
export async function createJobCheckoutSession(
  input: JobCheckoutInput
): Promise<{
  ok: boolean;
  url?: string;
  mode?: string;
  error?: string;
  stripeMode?: string;
  baseAmount?: number;
  feeAmount?: number;
  totalCharged?: number;
}> {
  const stripe = getStripe();
  if (!stripe) {
    return { ok: false, error: 'Stripe is not configured (STRIPE_SECRET_KEY).' };
  }

  const baseAmount = Math.max(0, Number(input.amount) || 0);
  if (baseAmount < 0.5) {
    return { ok: false, error: 'Amount must be at least $0.50.' };
  }

  const passFee =
    input.passProcessingFee !== undefined
      ? input.passProcessingFee
      : shouldPassProcessingFeeToPayee();
  const feeBreakdown = passFee
    ? computeStripeCardFee(baseAmount, {
        percentRate: input.feePercentRate,
        fixedFee: input.feeFixedUsd,
      })
    : null;
  const chargeTotal = feeBreakdown ? feeBreakdown.totalAmount : baseAmount;
  const cents = Math.round(baseAmount * 100);
  const feeCents = feeBreakdown ? Math.round(feeBreakdown.feeAmount * 100) : 0;

  if (Math.round(chargeTotal * 100) < 50) {
    return { ok: false, error: 'Amount must be at least $0.50.' };
  }

  const appUrl = getAppUrl(input.requestUrl);
  const account = await getPaymentAccount(input.ownerUserId);
  const connectedId = account?.stripe_account_id || null;
  const canChargeConnected = !!(connectedId && account?.charges_enabled);
  const stripeMode = getStripeMode();

  const kind = (input.paymentKind || 'payment').slice(0, 40);
  const metadata: Record<string, string> = {
    purpose: 'job_payment',
    payment_kind: kind,
    supabase_user_id: input.ownerUserId,
    invoice_id: input.invoiceId,
    invoice_number: input.invoiceNumber,
    document_type: input.documentType || 'invoice',
    job_name: (input.jobName || '').slice(0, 200),
    base_amount: baseAmount.toFixed(2),
    fee_amount: feeBreakdown ? feeBreakdown.feeAmount.toFixed(2) : '0',
    total_charged: chargeTotal.toFixed(2),
    stripe_mode: stripeMode,
  };

  const kindLabel =
    kind === 'deposit' ? 'Deposit' : kind === 'balance' ? 'Balance' : 'Payment';
  const productName = `${kindLabel} — ${input.documentType === 'invoice' ? 'Invoice' : 'Estimate'} ${input.invoiceNumber}`.slice(
    0,
    120
  );
  const description = (input.jobName || productName).slice(0, 200);

  const defaultSuccess = `${appUrl}/?job_paid=1&invoice=${encodeURIComponent(input.invoiceId)}`;
  const defaultCancel = `${appUrl}/?job_paid=0&invoice=${encodeURIComponent(input.invoiceId)}`;

  const line_items: Stripe.Checkout.SessionCreateParams.LineItem[] = [
    {
      quantity: 1,
      price_data: {
        currency: 'usd',
        unit_amount: cents,
        product_data: {
          name: productName,
          description,
        },
      },
    },
  ];

  if (feeBreakdown && feeCents > 0) {
    line_items.push({
      quantity: 1,
      price_data: {
        currency: 'usd',
        unit_amount: feeCents,
        product_data: {
          name: feeBreakdown.feeLabel,
          description: feeBreakdown.feeDescription.slice(0, 200),
        },
      },
    });
  }

  /**
   * Prefer automatic payment methods so Stripe can show:
   * card, Apple Pay / Google Pay (wallets), Link, US bank ACH when enabled.
   * Explicit payment_method_types alone often hides wallets / ACH incorrectly.
   */
  const sessionParams: Record<string, unknown> = {
    mode: 'payment',
    line_items,
    success_url: input.successUrl || defaultSuccess,
    cancel_url: input.cancelUrl || defaultCancel,
    metadata,
    payment_intent_data: {
      metadata,
    },
    automatic_payment_methods: {
      enabled: true,
      allow_redirects: 'always',
    },
  };

  if (input.clientEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.clientEmail)) {
    sessionParams.customer_email = input.clientEmail;
  }

  const createSession = async (params: Record<string, unknown>, opts?: Stripe.RequestOptions) => {
    try {
      return await stripe.checkout.sessions.create(
        params as Stripe.Checkout.SessionCreateParams,
        opts
      );
    } catch (e: any) {
      const msg = String(e?.message || '');
      // Fallback chain: card + ACH → card only
      if (/automatic_payment_methods|payment_method/i.test(msg)) {
        try {
          const withTypes = {
            ...params,
            automatic_payment_methods: undefined,
            payment_method_types: ['card', 'us_bank_account'],
          };
          return await stripe.checkout.sessions.create(
            withTypes as Stripe.Checkout.SessionCreateParams,
            opts
          );
        } catch (e2: any) {
          const msg2 = String(e2?.message || '');
          if (/us_bank_account|bank.account|payment_method_types/i.test(msg2)) {
            const cardOnly = {
              ...params,
              automatic_payment_methods: undefined,
              payment_method_types: ['card'],
            };
            return await stripe.checkout.sessions.create(
              cardOnly as Stripe.Checkout.SessionCreateParams,
              opts
            );
          }
          throw e2;
        }
      }
      if (/us_bank_account|bank.account|payment_method_types/i.test(msg)) {
        const cardOnly = {
          ...params,
          automatic_payment_methods: undefined,
          payment_method_types: ['card'],
        };
        return await stripe.checkout.sessions.create(
          cardOnly as Stripe.Checkout.SessionCreateParams,
          opts
        );
      }
      throw e;
    }
  };

  try {
    if (canChargeConnected && connectedId) {
      // Direct charge on connected account → money to contractor
      const session = await createSession(sessionParams, {
        stripeAccount: connectedId,
      });
      if (!session.url) return { ok: false, error: 'Stripe did not return a checkout URL.' };
      return {
        ok: true,
        url: session.url,
        mode: 'connect',
        stripeMode,
        baseAmount,
        feeAmount: feeBreakdown?.feeAmount ?? 0,
        totalCharged: chargeTotal,
      };
    }

    // Platform fallback (same Stripe as SaaS — for testing or sole operator)
    const session = await createSession({
      ...sessionParams,
      metadata: { ...metadata, settle_to: 'platform' },
      payment_intent_data: {
        metadata: { ...metadata, settle_to: 'platform' },
      },
    });
    if (!session.url) return { ok: false, error: 'Stripe did not return a checkout URL.' };
    return {
      ok: true,
      url: session.url,
      mode: 'platform',
      stripeMode,
      baseAmount,
      feeAmount: feeBreakdown?.feeAmount ?? 0,
      totalCharged: chargeTotal,
    };
  } catch (e: any) {
    console.error('createJobCheckoutSession:', e);
    return {
      ok: false,
      error:
        e?.message ||
        'Could not create Stripe Checkout. Use live keys (sk_live_…) for real payments, complete Connect, or check Stripe keys.',
    };
  }
}

/** Mark estimate/invoice paid after successful job Checkout (service role). */
export async function markDocumentPaidFromJobCheckout(session: Stripe.Checkout.Session): Promise<{
  ok: boolean;
  error?: string;
}> {
  if (session.metadata?.purpose !== 'job_payment') {
    return { ok: false, error: 'Not a job payment session' };
  }
  if (session.payment_status && session.payment_status !== 'paid') {
    return { ok: false, error: `Payment status: ${session.payment_status}` };
  }

  const admin = getSupabaseAdmin();
  if (!admin) return { ok: false, error: 'No admin client' };

  const invoiceId = String(session.metadata?.invoice_id || '').trim();
  const ownerId = String(session.metadata?.supabase_user_id || '').trim();
  if (!invoiceId || !ownerId) {
    return { ok: false, error: 'Missing invoice_id or user in metadata' };
  }

  // Prefer base job amount (exclude card fee line) so invoice balance is correct
  const baseFromMeta = Number(session.metadata?.base_amount);
  const amountTotal = session.amount_total != null ? session.amount_total / 100 : null;
  const jobPaidAmount =
    Number.isFinite(baseFromMeta) && baseFromMeta > 0
      ? baseFromMeta
      : amountTotal != null
        ? amountTotal
        : null;

  const { data: row, error: fetchErr } = await admin
    .from('estimates')
    .select('*')
    .eq('id', invoiceId)
    .eq('user_id', ownerId)
    .maybeSingle();

  if (fetchErr) {
    console.error('job pay fetch:', fetchErr);
  }

  const previousPaid = Number((row as any)?.amountPaid ?? (row as any)?.amountpaid ?? 0) || 0;
  const paidAmount =
    jobPaidAmount != null ? previousPaid + jobPaidAmount : previousPaid;

  const base = row || { id: invoiceId, user_id: ownerId };
  const updates: Record<string, unknown> = {
    id: invoiceId,
    user_id: ownerId,
    paymentStatus: 'paid',
    paymentstatus: 'paid',
    amountPaid: paidAmount,
    amountpaid: paidAmount,
    paymentMethod: 'Stripe',
    paymentmethod: 'Stripe',
    updated_at: new Date().toISOString(),
  };

  // Preserve other fields when we have the row
  if (row) {
    for (const [k, v] of Object.entries(row)) {
      if (updates[k] === undefined && k !== 'id') {
        // don't spread everything if lower-case DB
      }
    }
  }

  const camel = {
    id: invoiceId,
    user_id: ownerId,
    jobName: (row as any)?.jobName ?? (row as any)?.jobname ?? '',
    address: (row as any)?.address ?? '',
    city: (row as any)?.city ?? '',
    state: (row as any)?.state ?? '',
    zipCode: (row as any)?.zipCode ?? (row as any)?.zipcode ?? '',
    phones: (row as any)?.phones ?? [],
    emails: (row as any)?.emails ?? [],
    date: (row as any)?.date ?? '',
    invoiceNumber: (row as any)?.invoiceNumber ?? (row as any)?.invoicenumber ?? invoiceId,
    items: (row as any)?.items ?? [],
    terms: (row as any)?.terms ?? '',
    profile: (row as any)?.profile ?? {},
    documentType: (row as any)?.documentType ?? (row as any)?.documenttype ?? 'invoice',
    dueDate: (row as any)?.dueDate ?? (row as any)?.duedate ?? '',
    paymentStatus: 'paid',
    amountPaid: paidAmount || Number((row as any)?.amountPaid ?? (row as any)?.amountpaid) || 0,
    paymentMethod: 'Stripe',
    photoUrls: (row as any)?.photoUrls ?? (row as any)?.photourls ?? [],
    videoUrls: (row as any)?.videoUrls ?? (row as any)?.videourls ?? [],
    receiptUrls: (row as any)?.receiptUrls ?? (row as any)?.receipturls ?? [],
    receiptDetails: (row as any)?.receiptDetails ?? (row as any)?.receiptdetails ?? [],
    laborHours: (row as any)?.laborHours ?? (row as any)?.laborhours ?? 0,
    laborRate: (row as any)?.laborRate ?? (row as any)?.laborrate ?? 0,
    laborFixedAmount: (row as any)?.laborFixedAmount ?? (row as any)?.laborfixedamount ?? 0,
    useHourlyLabor: (row as any)?.useHourlyLabor ?? (row as any)?.usehourlylabor ?? true,
    laborAmount: (row as any)?.laborAmount ?? (row as any)?.laboramount ?? 0,
    taxRate: (row as any)?.taxRate ?? (row as any)?.taxrate ?? 0,
    taxAmount: (row as any)?.taxAmount ?? (row as any)?.taxamount ?? 0,
    isTaxExempt: (row as any)?.isTaxExempt ?? (row as any)?.istaxexempt ?? false,
    taxLabor: (row as any)?.taxLabor ?? (row as any)?.taxlabor ?? true,
    updated_at: new Date().toISOString(),
  };

  let { error } = await admin.from('estimates').upsert(camel, { onConflict: 'id' });
  if (error) {
    const lower: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(camel)) {
      if (k === 'id' || k === 'user_id' || k === 'updated_at' || k === 'profile' || k === 'items' || k === 'terms' || k === 'phones' || k === 'emails' || k === 'address' || k === 'city' || k === 'state' || k === 'date') {
        lower[k] = v;
      } else {
        lower[k.toLowerCase()] = v;
      }
    }
    const r2 = await admin.from('estimates').upsert(lower, { onConflict: 'id' });
    error = r2.error;
  }

  if (error) {
    console.error('job pay mark paid:', error);
    return { ok: false, error: error.message };
  }

  return { ok: true };
}
