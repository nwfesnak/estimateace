import { NextRequest, NextResponse } from 'next/server';
import { verifyClientActionToken } from '@/lib/client-action-token';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { withEstimateApproval } from '@/lib/estimate-approval';

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
    const nextProfile = withEstimateApproval(prevProfile, {
      approvedAt,
      approvedBy: 'client',
    });

    const { error } = await admin
      .from('estimates')
      .update({
        profile: nextProfile,
        updated_at: approvedAt,
      })
      .eq('id', row.id)
      .eq('user_id', uid);

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
