import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/supabase/auth-user';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { CARD_PAYMENTS_NOT_SET_UP_CODE, createJobCheckoutSession } from '@/lib/job-payments';
import { enforceAppAccess } from '@/lib/billing-access';

/**
 * Create Stripe Checkout for an invoice/estimate balance (job payment).
 * Separate from SaaS /api/billing/checkout subscriptions.
 *
 * Auth: optional for public client pay later; for now requires contractor session
 * OR pass owner token. Client pay from send-preview uses contractor's open session
 * when contractor shows the page — for emailed clients we use a public token later.
 *
 * Current: authenticated user (contractor) creates the session (e.g. while on send preview
 * with client, or contractor opens pay for them). Session URL can be shared.
 */
export async function POST(request: NextRequest) {
  try {
    const { user, error } = await getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: error || 'Unauthorized' }, { status: 401 });
    }
    const paywall = await enforceAppAccess(user.id);
    if (paywall) return paywall;

    const body = await request.json().catch(() => ({}));
    const amount = Number(body.amount);
    const invoiceId = String(body.invoiceId || body.invoiceNumber || '').trim();
    const invoiceNumber = String(body.invoiceNumber || invoiceId).trim();
    const documentType = String(body.documentType || 'invoice');
    const jobName = String(body.jobName || '').trim();
    const clientEmail = String(body.clientEmail || '').trim();
    const passProcessingFee = body.passProcessingFee !== false;
    const feePercentRate =
      body.feePercentRate != null ? Number(body.feePercentRate) : undefined;

    if (!invoiceId) {
      return NextResponse.json({ error: 'invoiceId is required' }, { status: 400 });
    }
    if (!Number.isFinite(amount) || amount < 0.5) {
      return NextResponse.json({ error: 'amount must be at least $0.50' }, { status: 400 });
    }

    // Resolve owner workspace (crew → owner)
    let ownerUserId = user.id;
    const admin = getSupabaseAdmin();
    if (admin) {
      try {
        const { data: crew } = await admin
          .from('crew_members')
          .select('owner_user_id')
          .eq('crew_user_id', user.id)
          .maybeSingle();
        if (crew?.owner_user_id) ownerUserId = crew.owner_user_id;
      } catch {
        /* optional */
      }
    }

    const result = await createJobCheckoutSession({
      ownerUserId,
      amount,
      invoiceId,
      invoiceNumber,
      documentType,
      jobName,
      clientEmail: clientEmail || undefined,
      requestUrl: request.url,
      passProcessingFee,
      feePercentRate: Number.isFinite(feePercentRate as number) ? feePercentRate : undefined,
    });

    if (!result.ok || !result.url) {
      if (result.code === CARD_PAYMENTS_NOT_SET_UP_CODE) {
        return NextResponse.json(
          {
            error:
              'Card payments are not set up yet. Finish Stripe Connect under Profile → Payments so card payments go to your bank.',
            code: result.code,
          },
          { status: 409 }
        );
      }
      return NextResponse.json(
        { error: result.error || 'Could not create checkout' },
        { status: 400 }
      );
    }

    return NextResponse.json({
      ok: true,
      url: result.url,
      mode: result.mode,
      stripeMode: result.stripeMode,
      baseAmount: result.baseAmount,
      feeAmount: result.feeAmount,
      totalCharged: result.totalCharged,
      message: 'Checkout created on your connected Stripe account.',
    });
  } catch (e: any) {
    console.error('job-checkout:', e);
    return NextResponse.json({ error: 'Checkout failed' }, { status: 500 });
  }
}
