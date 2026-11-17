import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/supabase/auth-user';
import { createConnectDashboardLink, resolveWorkspaceOwner } from '@/lib/job-payments';

/**
 * Stripe Express dashboard login link for the workspace owner.
 * Lets contractors see payouts and change the bank account Stripe pays them to.
 */
export async function POST(request: NextRequest) {
  try {
    const { user, error } = await getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: error || 'Unauthorized' }, { status: 401 });
    }

    const { isCrew } = await resolveWorkspaceOwner(user.id);
    if (isCrew) {
      return NextResponse.json(
        { error: 'Only the account owner can open the Stripe dashboard.' },
        { status: 403 }
      );
    }

    const result = await createConnectDashboardLink(user.id);
    if (!result.ok || !result.url) {
      return NextResponse.json(
        { error: result.error || 'Could not open the Stripe dashboard.' },
        { status: 400 }
      );
    }
    return NextResponse.json({ ok: true, url: result.url });
  } catch (e: unknown) {
    console.error('connect dashboard:', e);
    return NextResponse.json({ error: (e as Error)?.message || 'Dashboard link failed' }, { status: 500 });
  }
}
