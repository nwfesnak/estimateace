import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/supabase/auth-user';
import { getStripe, getStripeMode, isStripeLiveMode } from '@/lib/stripe-server';
import {
  getPaymentAccount,
  resolveWorkspaceOwner,
  syncConnectAccountStatus,
} from '@/lib/job-payments';
import { STRIPE_CARD_FIXED_USD, STRIPE_CARD_PERCENT } from '@/lib/stripe-fees';

export async function GET(request: NextRequest) {
  try {
    const { user, error } = await getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: error || 'Unauthorized' }, { status: 401 });
    }

    // Crew members see their owner's payment status (read-only).
    const { ownerUserId, isCrew } = await resolveWorkspaceOwner(user.id);

    const stripeOk = !!getStripe();
    const stripeMode = getStripeMode();
    const sync = request.nextUrl.searchParams.get('sync') === '1';

    let account = await getPaymentAccount(ownerUserId);
    // Pull live status from Stripe when asked, or whenever the stored flags say "not ready"
    // (onboarding may have finished without the app seeing an account.updated webhook yet).
    if (account?.stripe_account_id && (sync || !account.charges_enabled)) {
      const r = await syncConnectAccountStatus(ownerUserId);
      account = r.account;
    }

    const ready = !!(account?.stripe_account_id && account.charges_enabled);

    return NextResponse.json({
      stripeConfigured: stripeOk,
      stripeMode,
      isLive: isStripeLiveMode(),
      isTest: stripeMode === 'test',
      isCrew,
      canManage: !isCrew,
      connected: !!account?.stripe_account_id,
      chargesEnabled: !!account?.charges_enabled,
      payoutsEnabled: !!account?.payouts_enabled,
      detailsSubmitted: !!account?.details_submitted,
      accountType: account?.account_type || null,
      stripeAccountId: isCrew ? null : account?.stripe_account_id || null,
      /** Card job payments only when the owner's connected account can take charges */
      canAcceptJobCards: stripeOk && ready,
      connectReady: ready,
      mode: ready ? 'connect' : 'none',
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
