import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/supabase/auth-user';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { sendRecurringApprovalEmail } from '@/lib/recurring-services';

/**
 * Email client a recurring-charge approval button.
 * Does not affect EstimateAce SaaS subscription.
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
    if (!planId) {
      return NextResponse.json({ error: 'planId is required' }, { status: 400 });
    }

    const result = await sendRecurringApprovalEmail({
      ownerUserId,
      planId,
      requestUrl: request.url,
      companyName: body.companyName ? String(body.companyName) : undefined,
      companyEmail: body.companyEmail ? String(body.companyEmail) : undefined,
      companyPhone: body.companyPhone ? String(body.companyPhone) : undefined,
    });

    if (!result.ok) {
      return NextResponse.json(
        { error: result.error || 'Send failed', clientLink: result.clientLink },
        { status: 400 }
      );
    }

    return NextResponse.json({
      ok: true,
      clientLink: result.clientLink,
      message: 'Approval email sent to the client.',
    });
  } catch (e: any) {
    console.error('recurring/send:', e);
    return NextResponse.json({ error: e?.message || 'Send failed' }, { status: 500 });
  }
}
