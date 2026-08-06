import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/supabase/auth-user';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import {
  buildRecurringClientLink,
  createClientRecurringCheckout,
} from '@/lib/recurring-services';

/**
 * Contractor creates Stripe subscription Checkout for a client plan.
 * Separate from /api/billing/checkout (EstimateAce SaaS).
 */
export async function POST(request: NextRequest) {
  try {
    const { user, error } = await getUserFromRequest(request);
    if (!user) return NextResponse.json({ error: error || 'Unauthorized' }, { status: 401 });

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

    const body = await request.json().catch(() => ({}));
    const planId = String(body.planId || body.id || '').trim();
    if (!planId) return NextResponse.json({ error: 'planId is required' }, { status: 400 });

    // Link-only mode: just return client subscribe URL (no Stripe session yet)
    if (body.linkOnly) {
      const clientLink = buildRecurringClientLink(ownerUserId, planId, request.url);
      return NextResponse.json({ ok: true, clientLink });
    }

    const result = await createClientRecurringCheckout({
      ownerUserId,
      planId,
      requestUrl: request.url,
      clientEmail: body.clientEmail ? String(body.clientEmail) : undefined,
    });

    if (!result.ok || !result.url) {
      return NextResponse.json(
        {
          error: result.error || 'Could not create checkout',
          clientLink: buildRecurringClientLink(ownerUserId, planId, request.url),
        },
        { status: 400 }
      );
    }

    return NextResponse.json({
      ok: true,
      url: result.url,
      mode: result.mode,
      clientLink: buildRecurringClientLink(ownerUserId, planId, request.url),
      note: 'Client recurring billing only — not EstimateAce SaaS.',
    });
  } catch (e: any) {
    console.error('recurring/checkout:', e);
    return NextResponse.json({ error: e?.message || 'Failed' }, { status: 500 });
  }
}
