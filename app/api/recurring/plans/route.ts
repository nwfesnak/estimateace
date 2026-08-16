import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/supabase/auth-user';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import {
  createRecurringPlan,
  listRecurringPlans,
  updateRecurringPlan,
  cancelClientRecurringSubscription,
  restoreRecurringPlanFromArchive,
  pauseClientRecurringPayments,
  resumeClientRecurringPayments,
  buildRecurringClientLink,
  type RecurringInterval,
} from '@/lib/recurring-services';

async function resolveOwnerId(userId: string): Promise<string> {
  let ownerUserId = userId;
  const admin = getSupabaseAdmin();
  if (admin) {
    try {
      const { data: crew } = await admin
        .from('crew_members')
        .select('owner_user_id')
        .eq('crew_user_id', userId)
        .maybeSingle();
      if (crew?.owner_user_id) ownerUserId = crew.owner_user_id;
    } catch {
      /* optional */
    }
  }
  return ownerUserId;
}

/** List recurring client service plans (not EstimateAce SaaS). */
export async function GET(request: NextRequest) {
  try {
    const { user, error } = await getUserFromRequest(request);
    if (!user) return NextResponse.json({ error: error || 'Unauthorized' }, { status: 401 });

    const ownerId = await resolveOwnerId(user.id);
    const plans = await listRecurringPlans(ownerId);
    return NextResponse.json({
      ok: true,
      plans,
      note: 'These bill your clients only. Separate from EstimateAce monthly/yearly subscription.',
    });
  } catch (e: any) {
    console.error('recurring/plans GET:', e);
    return NextResponse.json({ error: e?.message || 'Failed' }, { status: 500 });
  }
}

/** Create a new client recurring plan. */
export async function POST(request: NextRequest) {
  try {
    const { user, error } = await getUserFromRequest(request);
    if (!user) return NextResponse.json({ error: error || 'Unauthorized' }, { status: 401 });

    const ownerId = await resolveOwnerId(user.id);
    const body = await request.json().catch(() => ({}));
    const interval = (['week', 'month', 'year'].includes(body.interval)
      ? body.interval
      : 'month') as RecurringInterval;

    const result = await createRecurringPlan(ownerId, {
      serviceName: String(body.serviceName || '').trim(),
      clientName: String(body.clientName || '').trim(),
      clientEmail: String(body.clientEmail || '').trim(),
      clientPhone: String(body.clientPhone || '').trim(),
      address: String(body.address || '').trim(),
      city: String(body.city || '').trim(),
      state: String(body.state || '').trim(),
      zipCode: String(body.zipCode || '').trim(),
      amount: Number(body.amount),
      interval,
      description: String(body.description || '').trim(),
      companyName: String(body.companyName || '').trim(),
      companyEmail: String(body.companyEmail || '').trim(),
      companyPhone: String(body.companyPhone || '').trim(),
    });

    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }

    const clientLink = buildRecurringClientLink(ownerId, result.plan.id, request.url);
    return NextResponse.json({ ok: true, plan: result.plan, clientLink });
  } catch (e: any) {
    console.error('recurring/plans POST:', e);
    return NextResponse.json({ error: e?.message || 'Failed' }, { status: 500 });
  }
}

/** Update or cancel a plan. Body: { id, action?: 'cancel' | 'update' | 'pause' | 'resume' | 'restore', ...fields } */
export async function PATCH(request: NextRequest) {
  try {
    const { user, error } = await getUserFromRequest(request);
    if (!user) return NextResponse.json({ error: error || 'Unauthorized' }, { status: 401 });

    const ownerId = await resolveOwnerId(user.id);
    const body = await request.json().catch(() => ({}));
    // Treat missing action as field update (edit plan)
    const action = String(body.action || 'update').trim().toLowerCase() || 'update';
    const id = String(body.id || body.planId || body.archiveId || '').trim();

    // restore can use archiveId; other actions need a plan id
    if (action === 'restore') {
      const archiveId = String(body.archiveId || body.id || '').trim();
      if (!archiveId) {
        return NextResponse.json(
          { error: 'archiveId is required to restore a canceled recurring plan' },
          { status: 400 }
        );
      }
      const result = await restoreRecurringPlanFromArchive(ownerId, archiveId);
      if (!result.ok) {
        return NextResponse.json({ error: result.error || 'Could not restore' }, { status: 400 });
      }
      return NextResponse.json({
        ok: true,
        plan: result.plan || null,
        planId: result.planId || result.plan?.id || null,
        message:
          'Plan restored to Recurring Charges as a draft. Re-email the client if they need to approve again.',
      });
    }

    if (!id) {
      return NextResponse.json(
        { error: 'id is required (recurring plan id, e.g. REC-…)' },
        { status: 400 }
      );
    }

    if (action === 'cancel') {
      const result = await cancelClientRecurringSubscription(ownerId, id);
      if (!result.ok) {
        return NextResponse.json(
          { error: result.error || 'Could not cancel', archiveId: result.archiveId },
          { status: 400 }
        );
      }
      return NextResponse.json({
        ok: true,
        plan: result.plan ?? null,
        archiveId: result.archiveId || null,
        message:
          'Plan canceled, removed from Recurring Charges, and filed under Paid invoices (Reports).',
      });
    }

    if (action === 'pause') {
      const result = await pauseClientRecurringPayments(ownerId, id);
      if (!result.ok) {
        return NextResponse.json(
          { error: result.error || 'Could not turn off payments' },
          { status: 400 }
        );
      }
      return NextResponse.json({
        ok: true,
        plan: result.plan || null,
        message: 'Payments turned off. Plan stays under Recurring — Payments off.',
      });
    }

    if (action === 'resume') {
      const result = await resumeClientRecurringPayments(ownerId, id);
      if (!result.ok) {
        return NextResponse.json(
          { error: result.error || 'Could not turn payments back on' },
          { status: 400 }
        );
      }
      return NextResponse.json({
        ok: true,
        plan: result.plan || null,
        message: 'Payments turned back on.',
      });
    }

    // Default: field update (edit plan details)
    const patch: any = {};
    if (body.serviceName != null) patch.serviceName = String(body.serviceName).trim();
    if (body.clientName != null) patch.clientName = String(body.clientName).trim();
    if (body.clientEmail != null) {
      const em = String(body.clientEmail).trim().toLowerCase().replace(/\s+/g, '');
      if (em && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) {
        return NextResponse.json(
          { error: 'Client email looks invalid. Use a full address like name@email.com' },
          { status: 400 }
        );
      }
      patch.clientEmail = em;
    }
    if (body.clientPhone != null) patch.clientPhone = String(body.clientPhone).trim();
    if (body.address != null) patch.address = String(body.address).trim();
    if (body.city != null) patch.city = String(body.city).trim();
    if (body.state != null) patch.state = String(body.state).trim();
    if (body.zipCode != null) patch.zipCode = String(body.zipCode).trim();
    if (body.amount != null) {
      const amt = Number(body.amount);
      if (!Number.isFinite(amt) || amt < 0.5) {
        return NextResponse.json({ error: 'Amount must be at least $0.50' }, { status: 400 });
      }
      patch.amount = amt;
    }
    if (body.interval != null) {
      if (!['week', 'month', 'year'].includes(body.interval)) {
        return NextResponse.json({ error: 'Interval must be week, month, or year' }, { status: 400 });
      }
      patch.interval = body.interval;
    }
    if (body.description != null) patch.description = String(body.description).trim();
    if (body.status != null) patch.status = body.status;

    if (Object.keys(patch).length === 0) {
      return NextResponse.json(
        { error: 'Nothing to update. Pass fields or action=pause|resume|cancel|restore.' },
        { status: 400 }
      );
    }

    const result = await updateRecurringPlan(ownerId, id, patch);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
    return NextResponse.json({
      ok: true,
      plan: result.plan,
      message: 'Plan updated.',
    });
  } catch (e: any) {
    console.error('recurring/plans PATCH:', e);
    return NextResponse.json({ error: e?.message || 'Failed' }, { status: 500 });
  }
}
