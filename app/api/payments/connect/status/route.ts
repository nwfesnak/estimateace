import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/supabase/auth-user';
import { getStripe, getStripeMode, isStripeLiveMode } from '@/lib/stripe-server';
import { getPaymentAccount, syncConnectAccountStatus } from '@/lib/job-payments';
import { STRIPE_CARD_FIXED_USD, STRIPE_CARD_PERCENT } from '@/lib/stripe-fees';

export async function GET(request: NextRequest) {
  try {
    const { user, error } = await getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: error || 'Unauthorized' }, { status: 401 });
    }

    const stripeOk = !!getStripe();
    const stripeMode = getStripeMode();
    const sync = request.nextUrl.searchParams.get('sync') === '1';

    let account = await getPaymentAccount(user.id);
    if (sync && account?.stripe_account_id) {
      const r = await syncConnectAccountStatus(user.id);
      account = r.account;
    }

    const ready = !!(account?.stripe_account_id && account.charges_enabled);

    return NextResponse.json({
      stripeConfigured: stripeOk,
      stripeMode,
      isLive: isStripeLiveMode(),
      isTest: stripeMode === 'test',
      connected: !!account?.stripe_account_id,
      chargesEnabled: !!account?.charges_enabled,
      payoutsEnabled: !!account?.payouts_enabled,
      detailsSubmitted: !!account?.details_submitted,
      stripeAccountId: account?.stripe_account_id || null,
      /** Can accept card job payments (Connect ready OR platform fallback) */
      canAcceptJobCards: stripeOk && (ready || stripeOk),
      connectReady: ready,
      mode: ready ? 'connect' : stripeOk ? 'platform_fallback' : 'none',
      processingFee: {
        percent: STRIPE_CARD_PERCENT,
        fixedUsd: STRIPE_CARD_FIXED_USD,
        label: `Card fee ${STRIPE_CARD_PERCENT}% + $${STRIPE_CARD_FIXED_USD.toFixed(2)} (passed to client on card pay)`,
      },
    });
  } catch (e: any) {
    console.error('connect status:', e);
    return NextResponse.json({ error: e?.message || 'Status failed' }, { status: 500 });
  }
}
