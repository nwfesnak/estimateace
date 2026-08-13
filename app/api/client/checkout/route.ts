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
    const depositPercent =
      Number(body.depositPercent) || Number(profile.depositPercentage) || 0;
    const documentType = String(row?.documentType || row?.document_type || typ || 'estimate');

    const { resolveAmountDue } = await import('@/lib/stripe-fees');
    const due = resolveAmountDue({
      documentType,
      grandTotal,
      amountPaid,
      depositPercent,
      showDepositOnApproval: profile.showDepositOnApproval !== false,
    });

    // Force correct amount: estimate → deposit; invoice → remaining balance
    let amount = due.amountDueNow;
    // Allow explicit amount only if it matches the due type and is valid
    if (Number(body.amount) >= 0.5 && Math.abs(Number(body.amount) - amount) < 0.02) {
      amount = Number(body.amount);
    }

    if (!Number.isFinite(amount) || amount < 0.5) {
      return NextResponse.json(
        {
          error:
            due.payKind === 'deposit'
              ? 'Deposit amount is too small or not set. Contact your contractor.'
              : 'Balance due is too small or already paid.',
        },
        { status: 400 }
      );
    }

    const invoiceNumber = String(row?.invoiceNumber || row?.invoicenumber || inv);
    const invoiceId = String(row?.id || inv);
    const jobName = String(row?.jobName || row?.jobname || body.jobName || '');

    // Pass processing fee to client only when contractor opted in (Profile → Client payments).
    // Zelle / mail check are outside Stripe and never include a fee.
    const chargeFees =
      profile.chargeCCFee === true ||
      profile.chargeCCFee === 'true' ||
      profile.chargeCCFee === 1 ||
      profile.chargeCCFee === '1';
    const feePercentRate = chargeFees
      ? Number(profile.ccFeePercentage) > 0
        ? Number(profile.ccFeePercentage)
        : 2.9
      : 0;

    const appUrl = getAppUrl(request.url);
    const returnBase = `${appUrl}/client/approve?token=${encodeURIComponent(token)}`;

    const result = await createJobCheckoutSession({
      ownerUserId: uid,
      amount,
      invoiceId,
      invoiceNumber,
      documentType: due.documentType,
      jobName,
      clientEmail: clientEmail || undefined,
      requestUrl: request.url,
      paymentKind: due.payKind,
      successUrl: `${returnBase}&paid=1`,
      cancelUrl: `${returnBase}&paid=0`,
      passProcessingFee: chargeFees,
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
