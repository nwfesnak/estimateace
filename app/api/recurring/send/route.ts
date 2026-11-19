import { NextRequest, NextResponse } from 'next/server';
import { requireWorkspaceOwner } from '@/lib/workspace';
import { getUserFromRequest } from '@/lib/supabase/auth-user';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { sendRecurringApprovalEmail } from '@/lib/recurring-services';
import { guardUserSends } from '@/lib/send-guard';
import { enforceAppAccess } from '@/lib/billing-access';

/**
 * Email client a recurring-charge approval button.
 * Does not affect EstimateAce SaaS subscription.
 */
export async function POST(request: NextRequest) {
  try {
    const { user, error } = await getUserFromRequest(request);
    if (!user) return NextResponse.json({ error: error || 'Unauthorized' }, { status: 401 });
    const paywall = await enforceAppAccess(user.id);
    if (paywall) return paywall;

    const admin = getSupabaseAdmin();
    // Seat-aware: inactive crew never act in the owner's workspace.
    const ws = await requireWorkspaceOwner(user.id, admin, { requireFinancials: true });
    if (ws.denied) return ws.denied;
    const ownerUserId = ws.ownerUserId;

    const body = await request.json().catch(() => ({}));
    const planId = String(body.planId || body.id || '').trim();
    if (!planId) {
      return NextResponse.json({ error: 'planId is required' }, { status: 400 });
    }

    {
      // One approval email + optional text per request; daily caps + confirmed email.
      const denied = await guardUserSends(user, ownerUserId, { email: 1, sms: 1 });
      if (denied) return denied;
    }

    const result = await sendRecurringApprovalEmail({
      ownerUserId,
      planId,
      requestUrl: request.url,
      companyName: body.companyName ? String(body.companyName) : undefined,
      companyEmail: body.companyEmail ? String(body.companyEmail) : undefined,
      companyPhone: body.companyPhone ? String(body.companyPhone) : undefined,
      clientEmail: body.clientEmail ? String(body.clientEmail) : undefined,
      clientPhone: body.clientPhone ? String(body.clientPhone) : undefined,
    });

    if (!result.ok) {
      const status =
        /not configured|RESEND|API_KEY|From address|verified|SERVICE_ROLE|Twilio|TWILIO/i.test(
          result.error || ''
        )
          ? 502
          : 400;
      return NextResponse.json(
        {
          ok: false,
          error: result.error || 'Send failed',
          clientLink: result.clientLink || null,
          to: result.to || null,
          smsTo: result.smsTo || null,
          emailSent: !!result.emailSent,
          smsSent: !!result.smsSent,
        },
        { status }
      );
    }

    const bits: string[] = [];
    if (result.emailSent && result.to) bits.push(`email → ${result.to}`);
    if (result.smsSent && result.smsTo) bits.push(`SMS → ${result.smsTo}`);
    return NextResponse.json({
      ok: true,
      clientLink: result.clientLink,
      to: result.to || null,
      smsTo: result.smsTo || null,
      emailSent: !!result.emailSent,
      smsSent: !!result.smsSent,
      resendId: result.resendId || null,
      message: `Approval sent (${bits.join(' · ') || 'ok'}).`,
    });
  } catch (e: any) {
    console.error('recurring/send:', e);
    return NextResponse.json({ error: 'Send failed' }, { status: 500 });
  }
}
