import { NextRequest, NextResponse } from 'next/server';
import { verifyClientActionToken } from '@/lib/client-action-token';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { withEstimateApproval } from '@/lib/estimate-approval';
import {
  applyClientOptionSelection,
  isOptionalLine,
  lineOptionId,
  quoteTotalsForItems,
} from '@/lib/optional-line-items';

/**
 * Client marks an estimate approved (won job) without converting to invoice.
 * Body/query: { token }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const token = String(body.token || request.nextUrl.searchParams.get('token') || '').trim();
    const verified = verifyClientActionToken(token);
    if (!verified.ok) {
      return NextResponse.json({ error: verified.error }, { status: 400 });
    }

    const { uid, inv, typ } = verified.payload;
    if (typ === 'invoice') {
      return NextResponse.json(
        { error: 'This link is for an invoice. Approval is only for estimates.' },
        { status: 400 }
      );
    }

    const admin = getSupabaseAdmin();
    if (!admin) {
      return NextResponse.json(
        { error: 'Server is missing SUPABASE_SERVICE_ROLE_KEY.' },
        { status: 500 }
      );
    }

    let row: any = null;
    const byId = await admin.from('estimates').select('*').eq('id', inv).eq('user_id', uid).maybeSingle();
    if (byId.data) row = byId.data;
    if (!row) {
      const byNum = await admin
        .from('estimates')
        .select('*')
        .eq('user_id', uid)
        .eq('invoiceNumber', inv)
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      row = byNum.data;
    }
    if (!row) {
      const byNum2 = await admin
        .from('estimates')
        .select('*')
        .eq('user_id', uid)
        .eq('invoicenumber', inv)
        .limit(1)
        .maybeSingle();
      row = byNum2.data;
    }

    if (!row) {
      return NextResponse.json({ error: 'Estimate not found.' }, { status: 404 });
    }

    const docType = String(row.documentType || row.documenttype || typ || 'estimate').toLowerCase();
    if (docType === 'invoice') {
      return NextResponse.json(
        { error: 'This document is already an invoice.' },
        { status: 400 }
      );
    }

    const approvedAt = new Date().toISOString();
    const prevProfile = row.profile && typeof row.profile === 'object' ? row.profile : {};
    const sourceItems = Array.isArray(row.items) ? row.items : [];
    const selectedIds = Array.isArray(body.selectedOptionIds)
      ? body.selectedOptionIds.map((id: any) => String(id))
      : sourceItems
          .map((item: any, index: number) =>
            isOptionalLine(item) && item.clientSelected ? lineOptionId(item, index) : ''
          )
          .filter(Boolean);

    const optionalItems = sourceItems.filter((item: any) => isOptionalLine(item));
    const allOptional = sourceItems.length > 0 && optionalItems.length === sourceItems.length;
    if (allOptional && selectedIds.length === 0) {
      return NextResponse.json(
        { error: 'Choose at least one option before approving this estimate.' },
        { status: 400 }
      );
    }

    const nextItems =
      optionalItems.length > 0
        ? applyClientOptionSelection(sourceItems, selectedIds)
        : sourceItems;
    const storedDiscount = prevProfile._discount || {};
    const totals = quoteTotalsForItems({
      items: nextItems,
      discount: {
        description: row.discountDescription || storedDiscount.discountDescription || '',
        value: Number(row.discountValue ?? storedDiscount.discountValue) || 0,
        type: (row.discountType || storedDiscount.discountType) === 'percent' ? 'percent' : 'dollar',
        amount: Number(row.discountAmount ?? storedDiscount.discountAmount) || 0,
      },
      taxRate: Number(row.taxRate ?? row.taxrate) || 0,
      taxesEnabled: prevProfile.taxesEnabled !== false,
      isTaxExempt: !!(row.isTaxExempt ?? row.istaxexempt),
    });

    const nextProfile = withEstimateApproval(prevProfile, {
      approvedAt,
      approvedBy: 'client',
    }) as Record<string, unknown>;
    nextProfile._clientSelectedOptionIds = selectedIds;

    const attempts: Record<string, unknown>[] = [
      {
        profile: nextProfile,
        items: nextItems,
        taxAmount: totals.taxAmount,
        discountAmount: totals.discountAmount,
        updated_at: approvedAt,
      },
      {
        profile: nextProfile,
        items: nextItems,
        taxamount: totals.taxAmount,
        discountamount: totals.discountAmount,
        updated_at: approvedAt,
      },
      {
        profile: nextProfile,
        items: nextItems,
        taxAmount: totals.taxAmount,
        updated_at: approvedAt,
      },
    ];
    let error: { message: string } | null = null;
    for (const patch of attempts) {
      const result = await admin.from('estimates').update(patch).eq('id', row.id).eq('user_id', uid);
      if (!result.error) {
        error = null;
        break;
      }
      error = result.error;
    }

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({
      ok: true,
      approved: true,
      approvedAt,
      approvedBy: 'client',
      message: 'Estimate approved. Your contractor can schedule the job.',
    });
  } catch (e: any) {
    console.error('client/approve:', e);
    return NextResponse.json({ error: e?.message || 'Failed' }, { status: 500 });
  }
}
