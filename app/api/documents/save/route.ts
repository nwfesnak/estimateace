import { NextRequest, NextResponse } from 'next/server';
import { crewPermissionDeniedResponse, requireWorkspaceOwner } from '@/lib/workspace';
import { crewCanWriteDocumentRow } from '@/lib/crew-tab-access';
import { getUserFromRequest } from '@/lib/supabase/auth-user';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import {
  formatSaveError,
  toCamelEstimateRow,
  toLowerEstimateRow,
  toMinimalEstimateRow,
  type EstimateSaveInput,
} from '@/lib/estimate-save';
import { enforceAppAccess } from '@/lib/billing-access';
import { restoreDocumentForCrewWrite } from '@/lib/crew-access';
import { isReservedDocumentId } from '@/lib/company-profile-access';

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
    const paywall = await enforceAppAccess(user.id);
    if (paywall) return paywall;

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
    // Seat-aware: inactive crew never act in the owner's workspace.
    const ws = await requireWorkspaceOwner(user.id, admin);
    if (ws.denied) return ws.denied;
    const workspaceUserId = ws.ownerUserId;

    // Reserved server-managed rows can never be written through this endpoint.
    if (isReservedDocumentId(id)) {
      return NextResponse.json({ error: 'Reserved document id.' }, { status: 400 });
    }

    // Ownership check: document ids are primary keys shared by every account, so an
    // existing row with this id must already belong to this workspace. Otherwise we
    // would overwrite (and take over) another contractor's document.
    let ownsExisting = false;
    {
      const { data: existingRow, error: existingErr } = await admin
        .from('estimates')
        .select('*')
        .eq('id', id)
        .maybeSingle();
      if (existingErr) {
        console.error('documents/save ownership check:', existingErr);
        return NextResponse.json({ error: 'Could not verify document ownership.' }, { status: 500 });
      }
      if (existingRow && String(existingRow.user_id) !== String(workspaceUserId)) {
        return NextResponse.json(
          {
            error:
              'That document number is already used by another account. Start a new estimate to get a fresh number.',
            code: 'document_id_taken',
          },
          { status: 409 }
        );
      }
      ownsExisting = Boolean(existingRow);
      if (ws.isCrew) {
        if (existingRow && !crewCanWriteDocumentRow(ws.tabAccess, existingRow as Record<string, unknown>, { isNew: false })) {
          return crewPermissionDeniedResponse();
        }
        if (
          !crewCanWriteDocumentRow(
            ws.tabAccess,
            { id, documentType: body.documentType },
            { isNew: !ownsExisting }
          )
        ) {
          return crewPermissionDeniedResponse();
        }
      }
    }

    const rawInput: EstimateSaveInput = {
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
    // Restricted crew only ever see redacted prices/financials: put the owner's real
    // values back so a crew save can never zero them out.
    const input = (await restoreDocumentForCrewWrite(
      admin,
      user.id,
      id,
      rawInput as unknown as Record<string, unknown>
    )) as unknown as EstimateSaveInput;

    const attempts = [
      { name: 'camelCase', row: toCamelEstimateRow(input) },
      { name: 'lowercase', row: toLowerEstimateRow(input) },
      { name: 'minimal', row: toMinimalEstimateRow(input) },
    ];

    const errors: string[] = [];
    for (const attempt of attempts) {
      // Update only our own row; insert (never upsert) new ids so a concurrent insert of
      // the same id by another account fails instead of being overwritten.
      const writeRow = () =>
        ownsExisting
          ? admin
              .from('estimates')
              .update(attempt.row)
              .eq('id', id)
              .eq('user_id', workspaceUserId)
          : admin.from('estimates').insert(attempt.row);
      let { error } = await writeRow();
      if (error && (error as { code?: string }).code === '23505') {
        // Lost an insert race: fine if the row that won is ours (double-tap Save).
        const { data: winner } = await admin
          .from('estimates')
          .select('user_id')
          .eq('id', id)
          .maybeSingle();
        if (winner && String(winner.user_id) === String(workspaceUserId)) {
          ownsExisting = true;
          ({ error } = await writeRow());
        }
      }
      if (error && (error as { code?: string }).code === '23505') {
        return NextResponse.json(
          {
            error:
              'That document number is already used by another account. Start a new estimate to get a fresh number.',
            code: 'document_id_taken',
          },
          { status: 409 }
        );
      }
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
    return NextResponse.json({ error: 'Save failed' }, { status: 500 });
  }
}
