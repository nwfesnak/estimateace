import { NextRequest, NextResponse } from 'next/server';
import { verifyClientActionToken } from '@/lib/client-action-token';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { extractMediaStoragePath, isMediaPdfRef } from '@/lib/media-url';

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
      // Also surface COI from SETTINGS if contractor has one uploaded
      let hasCertificate = false;
      let certificateUrl = '';
      let certificateIsPdf = false;
      let companyFallback = 'Your contractor';
      try {
        const { data: settingsRow } = await admin
          .from('estimates')
          .select('profile')
          .eq('id', `SETTINGS-${uid}`)
          .maybeSingle();
        const sp = (settingsRow?.profile || {}) as any;
        if (sp?.company) companyFallback = String(sp.company);
        const certRef = String(sp?.certificateUrl || '').trim();
        if (certRef) {
          certificateIsPdf = isMediaPdfRef(certRef);
          const storagePath = extractMediaStoragePath(certRef);
          if (storagePath) {
            const { data: signed } = await admin.storage
              .from('media')
              .createSignedUrl(storagePath, 60 * 60);
            if (signed?.signedUrl) {
              hasCertificate = true;
              certificateUrl = signed.signedUrl;
            }
          } else if (/^https?:\/\//i.test(certRef)) {
            hasCertificate = true;
            certificateUrl = certRef;
          }
        }
      } catch {
        /* optional */
      }
      return NextResponse.json({
        ok: true,
        fromDb: false,
        documentType: typ,
        invoiceNumber: inv,
        jobName: 'Your project',
        company: companyFallback,
        grandTotal: 0,
        amountPaid: 0,
        balanceDue: 0,
        depositPercent: 0,
        depositDue: 0,
        showDeposit: typ === 'estimate',
        items: [],
        hasCertificate,
        certificateUrl,
        certificateIsPdf,
        message: 'Document details will be confirmed with your contractor.',
      });
    }

    let profile = (row.profile || {}) as any;
    // Merge latest company payment settings from SETTINGS so pay link shows all enabled methods
    try {
      const { data: settingsRow } = await admin
        .from('estimates')
        .select('profile')
        .eq('id', `SETTINGS-${uid}`)
        .maybeSingle();
      const sp = (settingsRow?.profile || {}) as any;
      if (sp && typeof sp === 'object') {
        profile = {
          ...profile,
          paymentSettings: {
            ...(profile.paymentSettings || {}),
            ...(sp.paymentSettings || {}),
          },
          chargeCCFee: sp.chargeCCFee !== undefined ? sp.chargeCCFee : profile.chargeCCFee,
          ccFeePercentage: sp.ccFeePercentage ?? profile.ccFeePercentage,
          company: profile.company || sp.company,
          phone: profile.phone || sp.phone,
          email: profile.email || sp.email,
          // Prefer live company certificate over document snapshot
          certificateUrl: String(sp.certificateUrl || profile.certificateUrl || '').trim(),
        };
      }
    } catch {
      /* optional */
    }
    const storedDiscount = profile._discount || {};
    const items = Array.isArray(row.items) ? row.items : [];
    const itemsTotal = items.reduce((sum: number, it: any) => {
      const t = Number(it.total);
      if (t > 0) return sum + t;
      return sum + (Number(it.qty) || 0) * (Number(it.price) || 0);
    }, 0);

    const discountDescription = String(
      row.discountDescription || storedDiscount.discountDescription || ''
    ).trim();
    const discountType =
      (row.discountType || storedDiscount.discountType) === 'percent' ? 'percent' : 'dollar';
    const discountValue = Number(row.discountValue ?? storedDiscount.discountValue) || 0;
    let discountAmount = Number(row.discountAmount ?? storedDiscount.discountAmount) || 0;
    if (!(discountAmount > 0) && discountValue > 0 && itemsTotal > 0) {
      discountAmount =
        discountType === 'percent'
          ? Math.round(Math.min(itemsTotal, itemsTotal * (discountValue / 100)) * 100) / 100
          : Math.round(Math.min(itemsTotal, discountValue) * 100) / 100;
    }
    const subtotalBeforeDiscount = itemsTotal;
    const subtotalAfterDiscount = Math.max(0, itemsTotal - discountAmount);

    // Prefer stored totals if present on row
    const grandTotal =
      Number(row.grandTotal) ||
      Number(row.grand_total) ||
      (Number(row.taxAmount) > 0
        ? subtotalAfterDiscount + Number(row.taxAmount)
        : subtotalAfterDiscount) ||
      itemsTotal ||
      0;
    const amountPaid = Number(row.amountPaid ?? row.amount_paid) || 0;
    const taxAmount = Number(row.taxAmount ?? row.tax_amount) || 0;
    const depositPercent = Number(profile.depositPercentage) || 0;
    const docTypeRaw = String(row.documentType || row.document_type || typ || 'estimate');

    const { resolveAmountDue } = await import('@/lib/stripe-fees');
    const due = resolveAmountDue({
      documentType: docTypeRaw,
      grandTotal,
      amountPaid,
      depositPercent,
      showDepositOnApproval: profile.showDepositOnApproval !== false,
    });

    const invoiceNumber = row.invoiceNumber || row.invoicenumber || inv;
    const company = profile.company || 'Your contractor';
    const feePercent =
      profile.chargeCCFee !== false && Number(profile.ccFeePercentage) > 0
        ? Number(profile.ccFeePercentage)
        : 2.9;

    // All methods the contractor enabled — each total includes processing fee
    const { buildClientPaymentOptions } = await import('@/lib/client-payment-options');
    const paymentOptions = buildClientPaymentOptions({
      paymentSettings: profile.paymentSettings || {},
      amount: due.amountDueNow,
      invoiceNumber: String(invoiceNumber),
      company,
      label: due.payLabel,
      feePercentRate: feePercent,
    });

    // Certificate of Insurance — signed URL for client view (only if uploaded)
    let hasCertificate = false;
    let certificateUrl = '';
    let certificateIsPdf = false;
    const certRef = String(profile.certificateUrl || '').trim();
    if (certRef) {
      certificateIsPdf = isMediaPdfRef(certRef);
      const storagePath = extractMediaStoragePath(certRef);
      if (storagePath) {
        try {
          const { data: signed } = await admin.storage
            .from('media')
            .createSignedUrl(storagePath, 60 * 60); // 1h — page can refresh
          if (signed?.signedUrl) {
            hasCertificate = true;
            certificateUrl = signed.signedUrl;
          }
        } catch {
          /* optional */
        }
      } else if (/^https?:\/\//i.test(certRef)) {
        hasCertificate = true;
        certificateUrl = certRef;
      }
    }

    return NextResponse.json({
      ok: true,
      fromDb: true,
      documentType: due.documentType,
      invoiceNumber,
      jobName: row.jobName || row.jobname || 'Your project',
      company,
      companyPhone: profile.phone || '',
      companyEmail: profile.email || '',
      address: [row.address, row.city, row.state, row.zipCode || row.zipcode]
        .filter(Boolean)
        .join(', '),
      date: row.date || '',
      subtotalBeforeDiscount,
      discountAmount,
      discountDescription: discountDescription || (discountAmount > 0 ? 'Discount' : ''),
      discountType,
      discountValue,
      taxAmount,
      grandTotal: due.grandTotal,
      amountPaid: due.amountPaid,
      balanceDue: due.balanceDue,
      depositPercent: due.depositPercent,
      depositDue: due.depositDue,
      /** Estimate → deposit; invoice → full remaining balance */
      showDeposit: due.payKind === 'deposit',
      amountDueNow: due.amountDueNow,
      payKind: due.payKind,
      payLabel: due.payLabel,
      paymentStatus: row.paymentStatus || row.payment_status || 'unpaid',
      terms: String(row.terms || profile.disclosure || '').slice(0, 8000),
      chargeCCFee: profile.chargeCCFee !== false,
      ccFeePercentage: feePercent,
      paymentOptions,
      hasCertificate,
      certificateUrl,
      certificateIsPdf,
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
