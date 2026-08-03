import { NextRequest, NextResponse } from 'next/server';
import { verifyClientActionToken } from '@/lib/client-action-token';
import { getSupabaseAdmin } from '@/lib/supabase/admin';

/**
 * Public (token-gated) document summary for client approve / pay page.
 */
export async function GET(request: NextRequest) {
  try {
    const token = String(request.nextUrl.searchParams.get('token') || '').trim();
    const verified = verifyClientActionToken(token);
    if (!verified.ok) {
      return NextResponse.json({ error: verified.error }, { status: 400 });
    }

    const { uid, inv, typ } = verified.payload;
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
    // Some schemas use snake_case
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
      // Still allow CTA page using token + optional body cache — minimal fallback
      return NextResponse.json({
        ok: true,
        fromDb: false,
        documentType: typ,
        invoiceNumber: inv,
        jobName: 'Your project',
        company: 'Your contractor',
        grandTotal: 0,
        amountPaid: 0,
        balanceDue: 0,
        depositPercent: 0,
        depositDue: 0,
        showDeposit: typ === 'estimate',
        items: [],
        message: 'Document details will be confirmed with your contractor.',
      });
    }

    const profile = (row.profile || {}) as any;
    const items = Array.isArray(row.items) ? row.items : [];
    const itemsTotal = items.reduce((sum: number, it: any) => {
      const t = Number(it.total);
      if (t > 0) return sum + t;
      return sum + (Number(it.qty) || 0) * (Number(it.price) || 0);
    }, 0);

    // Prefer stored totals if present on row
    const grandTotal =
      Number(row.grandTotal) ||
      Number(row.grand_total) ||
      itemsTotal ||
      0;
    const amountPaid = Number(row.amountPaid ?? row.amount_paid) || 0;
    const balanceDue = Math.max(0, grandTotal - amountPaid);
    const depositPercent = Number(profile.depositPercentage) || 0;
    const showDeposit =
      typ === 'estimate'
        ? profile.showDepositOnApproval !== false && depositPercent > 0
        : false;
    const depositDue = showDeposit
      ? Math.round(((grandTotal * depositPercent) / 100) * 100) / 100
      : 0;

    return NextResponse.json({
      ok: true,
      fromDb: true,
      documentType: row.documentType || row.document_type || typ,
      invoiceNumber: row.invoiceNumber || row.invoicenumber || inv,
      jobName: row.jobName || row.jobname || 'Your project',
      company: profile.company || 'Your contractor',
      companyPhone: profile.phone || '',
      companyEmail: profile.email || '',
      address: [row.address, row.city, row.state, row.zipCode || row.zipcode]
        .filter(Boolean)
        .join(', '),
      date: row.date || '',
      grandTotal,
      amountPaid,
      balanceDue,
      depositPercent,
      depositDue,
      showDeposit,
      paymentStatus: row.paymentStatus || row.payment_status || 'unpaid',
      terms: String(row.terms || profile.disclosure || '').slice(0, 8000),
      items: items.slice(0, 40).map((it: any) => ({
        description: String(it.description || 'Line item').slice(0, 200),
        qty: Number(it.qty) || 0,
        total: Number(it.total) || Number(it.qty || 0) * Number(it.price || 0),
      })),
    });
  } catch (e: any) {
    console.error('client/document:', e);
    return NextResponse.json({ error: e?.message || 'Failed to load' }, { status: 500 });
  }
}
