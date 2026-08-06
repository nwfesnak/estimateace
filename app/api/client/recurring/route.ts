import { NextRequest, NextResponse } from 'next/server';
import {
  createClientRecurringCheckout,
  getRecurringPlan,
  intervalLabel,
  markClientApprovedRecurring,
  money,
  verifyRecurringToken,
} from '@/lib/recurring-services';

/** Public: load recurring plan by client token */
export async function GET(request: NextRequest) {
  try {
    const token = String(request.nextUrl.searchParams.get('token') || '').trim();
    const verified = verifyRecurringToken(token);
    if (!verified.ok) {
      return NextResponse.json({ error: verified.error }, { status: 400 });
    }

    const { uid, inv } = verified.payload;
    const plan = await getRecurringPlan(uid, inv);
    if (!plan) {
      return NextResponse.json({ error: 'This service plan was not found.' }, { status: 404 });
    }

    return NextResponse.json({
      ok: true,
      plan: {
        id: plan.id,
        serviceName: plan.serviceName,
        clientName: plan.clientName,
        amount: plan.amount,
        interval: plan.interval,
        intervalLabel: intervalLabel(plan.interval),
        description: plan.description,
        status: plan.status,
        clientApprovedAt: plan.clientApprovedAt,
        companyName: plan.companyName || 'Your contractor',
        companyPhone: plan.companyPhone || '',
        companyEmail: plan.companyEmail || '',
        address: [plan.address, plan.city, plan.state, plan.zipCode].filter(Boolean).join(', '),
        amountLabel: money(plan.amount),
      },
      note: 'You are approving/paying your contractor for a recurring service — not EstimateAce software.',
    });
  } catch (e: any) {
    console.error('client/recurring GET:', e);
    return NextResponse.json({ error: e?.message || 'Failed' }, { status: 500 });
  }
}

/**
 * Public actions:
 * - action: 'approve' → record client approval
 * - action: 'checkout' or default → Stripe subscription checkout
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const token = String(body.token || '').trim();
    const action = String(body.action || 'checkout').toLowerCase();
    const verified = verifyRecurringToken(token);
    if (!verified.ok) {
      return NextResponse.json({ error: verified.error }, { status: 400 });
    }

    const { uid, inv } = verified.payload;

    if (action === 'approve') {
      const result = await markClientApprovedRecurring(uid, inv);
      if (!result.ok) {
        return NextResponse.json({ error: result.error }, { status: 400 });
      }
      return NextResponse.json({
        ok: true,
        approved: true,
        clientApprovedAt: result.plan.clientApprovedAt,
        status: result.plan.status,
        message: 'Thank you — you approved these recurring charges.',
      });
    }

    // Auto-mark approved when starting checkout if not already
    const plan = await getRecurringPlan(uid, inv);
    if (plan && !plan.clientApprovedAt && plan.status !== 'active' && plan.status !== 'canceled') {
      await markClientApprovedRecurring(uid, inv);
    }

    const result = await createClientRecurringCheckout({
      ownerUserId: uid,
      planId: inv,
      requestUrl: request.url,
      clientEmail: body.clientEmail ? String(body.clientEmail) : undefined,
    });

    if (!result.ok || !result.url) {
      return NextResponse.json(
        {
          error:
            result.error ||
            'Could not start checkout. Ask your contractor to enable card payments.',
        },
        { status: 400 }
      );
    }

    return NextResponse.json({ ok: true, url: result.url });
  } catch (e: any) {
    console.error('client/recurring POST:', e);
    return NextResponse.json({ error: e?.message || 'Failed' }, { status: 500 });
  }
}
