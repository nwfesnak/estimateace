import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/supabase/auth-user';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import {
  formatSaveError,
  toCamelEstimateRow,
  toLowerEstimateRow,
  toMinimalEstimateRow,
  type EstimateSaveInput,
} from '@/lib/estimate-save';

/**
 * Reliable estimate/invoice save via service role (after JWT auth).
 * Avoids client RLS / column-name mismatches that block browser upserts.
 */
export async function POST(request: NextRequest) {
  try {
    const { user, error: authError } = await getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: authError || 'Unauthorized' }, { status: 401 });
    }

    const admin = getSupabaseAdmin();
    if (!admin) {
      return NextResponse.json(
        { error: 'Server missing SUPABASE_SERVICE_ROLE_KEY. Add it in Vercel and redeploy.' },
        { status: 503 }
      );
    }

    const body = await request.json().catch(() => ({}));
    const id = String(body.id || body.invoiceNumber || '').trim();
    if (!id || id.toLowerCase() === 'undefined') {
      return NextResponse.json({ error: 'Document id is required' }, { status: 400 });
    }

    // Workspace: crew saves into owner account when linked
    let workspaceUserId = user.id;
    try {
      const { data: crew } = await admin
        .from('crew_members')
        .select('owner_user_id')
        .eq('crew_user_id', user.id)
        .maybeSingle();
      if (crew?.owner_user_id) workspaceUserId = crew.owner_user_id;
    } catch {
      /* crew table optional */
    }

    // Never allow writing as another user unless crew-of relationship
    if (body.user_id && body.user_id !== workspaceUserId && body.user_id !== user.id) {
      // ignore client-supplied user_id spoof
    }

    const input: EstimateSaveInput = {
      id,
      user_id: workspaceUserId,
      jobName: body.jobName,
      address: body.address,
      city: body.city,
      state: body.state,
      zipCode: body.zipCode,
      phones: body.phones,
      emails: body.emails,
      date: body.date,
      invoiceNumber: body.invoiceNumber || id,
      items: body.items,
      terms: body.terms,
      profile: body.profile,
      documentType: body.documentType || 'estimate',
      dueDate: body.dueDate,
      paymentStatus: body.paymentStatus,
      amountPaid: body.amountPaid,
      paymentMethod: body.paymentMethod,
      photoUrls: body.photoUrls,
      videoUrls: body.videoUrls,
      receiptUrls: body.receiptUrls,
      receiptDetails: body.receiptDetails,
      laborHours: body.laborHours,
      laborRate: body.laborRate,
      laborFixedAmount: body.laborFixedAmount,
      useHourlyLabor: body.useHourlyLabor,
      laborAmount: body.laborAmount,
      taxRate: body.taxRate,
      taxAmount: body.taxAmount,
      isTaxExempt: body.isTaxExempt,
      taxLabor: body.taxLabor,
      updated_at: new Date().toISOString(),
    };

    const attempts = [
      { name: 'camelCase', row: toCamelEstimateRow(input) },
      { name: 'lowercase', row: toLowerEstimateRow(input) },
      { name: 'minimal', row: toMinimalEstimateRow(input) },
    ];

    const errors: string[] = [];
    for (const attempt of attempts) {
      const { error } = await admin.from('estimates').upsert(attempt.row, { onConflict: 'id' });
      if (!error) {
        return NextResponse.json({
          ok: true,
          id,
          user_id: workspaceUserId,
          strategy: attempt.name,
        });
      }
      errors.push(`${attempt.name}: ${formatSaveError(error)}`);
      console.warn('documents/save attempt failed:', attempt.name, error);
    }

    return NextResponse.json(
      {
        error:
          'Could not save estimate to database. Check Supabase table "estimates" exists and columns match the app. ' +
          errors[0],
        errors,
      },
      { status: 500 }
    );
  } catch (e: any) {
    console.error('documents/save:', e);
    return NextResponse.json({ error: e?.message || 'Save failed' }, { status: 500 });
  }
}
