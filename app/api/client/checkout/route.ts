import { NextRequest, NextResponse } from 'next/server';
import { verifyClientActionToken } from '@/lib/client-action-token';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { createJobCheckoutSession } from '@/lib/job-payments';
import { getAppUrl } from '@/lib/stripe-server';

/**
 * Public (token-gated) Stripe Checkout for deposit / balance.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const token = String(body.token || '').trim();
    const kind = String(body.kind || 'deposit').toLowerCase() === 'balance' ? 'balance' : 'deposit';
    const clientEmail = String(body.clientEmail || '').trim();

    const verified = verifyClientActionToken(token);
    if (!verified.ok) {
      return NextResponse.json({ error: verified.error }, { status: 400 });
    }

    const { uid, inv, typ } = verified.payload;
    const admin = getSupabaseAdmin();

    let row: any = null;
    if (admin) {
      const byId = await admin.from('estimates').select('*').eq('id', inv).eq('user_id', uid).maybeSingle();
      row = byId.data;
      if (!row) {
        const byNum = await admin
          .from('estimates')
          .select('*')
          .eq('user_id', uid)
          .eq('invoiceNumber', inv)
          .limit(1)
          .maybeSingle();
        row = byNum.data;
      }
    }

    const profile = (row?.profile || {}) as any;
    const items = Array.isArray(row?.items) ? row.items : [];
    const itemsTotal = items.reduce((sum: number, it: any) => {
      const t = Number(it.total);
      if (t > 0) return sum + t;
      return sum + (Number(it.qty) || 0) * (Number(it.price) || 0);
    }, 0);
    const grandTotal =
      Number(body.grandTotal) ||
      Number(row?.grandTotal) ||
      Number(row?.grand_total) ||
      itemsTotal ||
      0;
    const amountPaid = Number(row?.amountPaid ?? row?.amount_paid) || 0;
    const balanceDue = Math.max(0, grandTotal - amountPaid);
    const depositPercent =
      Number(body.depositPercent) || Number(profile.depositPercentage) || 0;
    let amount =
      kind === 'balance'
        ? balanceDue
        : Math.round(((grandTotal * depositPercent) / 100) * 100) / 100;

    // Allow explicit amount from client page when DB missing (validated min)
    if ((!amount || amount < 0.5) && Number(body.amount) >= 0.5) {
      amount = Number(body.amount);
    }

    if (!Number.isFinite(amount) || amount < 0.5) {
      return NextResponse.json(
        {
          error:
            kind === 'deposit'
              ? 'Deposit amount is too small or not set. Contact your contractor.'
              : 'Balance due is too small or already paid.',
        },
        { status: 400 }
      );
    }

    const invoiceNumber = String(row?.invoiceNumber || row?.invoicenumber || inv);
    const invoiceId = String(row?.id || inv);
    const jobName = String(row?.jobName || row?.jobname || body.jobName || '');
    const documentType = String(row?.documentType || row?.document_type || typ || 'estimate');

    // Pass card processing fee to payee (shown as its own Checkout line)
    const chargeCCFee = profile.chargeCCFee !== false;
    const feePercentRate =
      chargeCCFee && Number(profile.ccFeePercentage) > 0
        ? Number(profile.ccFeePercentage)
        : 2.9;

    const appUrl = getAppUrl(request.url);
    const returnBase = `${appUrl}/client/approve?token=${encodeURIComponent(token)}`;

    const result = await createJobCheckoutSession({
      ownerUserId: uid,
      amount,
      invoiceId,
      invoiceNumber,
      documentType,
      jobName,
      clientEmail: clientEmail || undefined,
      requestUrl: request.url,
      paymentKind: kind,
      successUrl: `${returnBase}&paid=1`,
      cancelUrl: `${returnBase}&paid=0`,
      passProcessingFee: true,
      feePercentRate,
    });

    if (!result.ok || !result.url) {
      return NextResponse.json(
        {
          error:
            result.error ||
            'Could not start card payment. The contractor may still need to finish Stripe setup.',
        },
        { status: 400 }
      );
    }

    return NextResponse.json({
      ok: true,
      url: result.url,
      amount,
      kind,
      mode: result.mode,
    });
  } catch (e: any) {
    console.error('client/checkout:', e);
    return NextResponse.json({ error: e?.message || 'Checkout failed' }, { status: 500 });
  }
}
