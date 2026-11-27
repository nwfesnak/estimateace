import { NextRequest, NextResponse } from 'next/server';
import { verifyClientActionToken } from '@/lib/client-action-token';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { isMediaPdfRef } from '@/lib/media-url';
import { ownedMediaPath } from '@/lib/storage-paths';
import { readEstimateApproval } from '@/lib/estimate-approval';
import { CLIENT_MEDIA_LIMITS, planClientMedia, signClientMedia, type ClientMediaPayload } from '@/lib/client-media';
import { planClientLinePhotos, signClientLinePhotos } from '@/lib/line-item-photos';
import {
  includedItemsSubtotal,
  isClientSelectedOption,
  isOptionalLine,
  lineOptionId,
} from '@/lib/optional-line-items';
import { ITEM_TRANSLATION_KEYS, stripItemTranslations } from '@/lib/item-translations';

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
          // Only the contractor's own folder (never another account's file).
          const storagePath = ownedMediaPath(certRef, [uid]);
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
    let settingsProfile: Record<string, unknown> | null = null;
    // Merge latest company payment settings from SETTINGS so pay link shows all enabled methods
    try {
      const { data: settingsRow } = await admin
        .from('estimates')
        .select('profile')
        .eq('id', `SETTINGS-${uid}`)
        .maybeSingle();
      const sp = (settingsRow?.profile || {}) as any;
      if (sp && typeof sp === 'object') settingsProfile = sp;
      if (sp && typeof sp === 'object') {
        const { mergeFilledPaymentSettings } = await import('@/lib/client-payment-options');
        const { resolveJobSettingsFromDoc } = await import('@/lib/job-settings-snapshot');
        const snap = resolveJobSettingsFromDoc(profile, sp);
        profile = {
          ...profile,
          paymentSettings:
            typeof profile._jobSettingsSnapshottedAt === 'string'
              ? snap.paymentSettings
              : mergeFilledPaymentSettings(profile.paymentSettings, sp.paymentSettings),
          chargeCCFee: snap.chargeCCFee,
          ccFeePercentage: snap.ccFeePercentage,
          taxesEnabled: snap.taxesEnabled,
          termsDisplayMode: snap.termsDisplayMode,
          depositPercentage: snap.depositPercentage,
          showDepositOnApproval: snap.showDepositOnApproval,
          depositMinimumAmount: snap.depositMinimumAmount,
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
    const itemsTotal = includedItemsSubtotal(items);

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

    // Same formula as Stripe checkout / mark-paid (shared helper)
    const { computeDocumentGrandTotal } = await import('@/lib/document-totals');
    const grandTotal = computeDocumentGrandTotal(row);
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
      depositMinimumAmount: Math.max(0, Number(profile.depositMinimumAmount) || 0),
    });

    const invoiceNumber = row.invoiceNumber || row.invoicenumber || inv;
    const company = profile.company || 'Your contractor';
    // Processing fee only when contractor enables "Charge credit card processing fee".
    // Zelle and mail check never get a fee (enforced in buildClientPaymentOptions).
    const chargeFees =
      profile.chargeCCFee === true ||
      profile.chargeCCFee === 'true' ||
      profile.chargeCCFee === 1 ||
      profile.chargeCCFee === '1';
    const feePercent = chargeFees
      ? Number(profile.ccFeePercentage) > 0
        ? Number(profile.ccFeePercentage)
        : 2.9
      : 0;

    // Only offer Stripe card / bank when the contractor's own connected account can take charges.
    let stripeReady = false;
    try {
      const { ensureConnectReady } = await import('@/lib/job-payments');
      stripeReady = (await ensureConnectReady(uid)).ready;
    } catch (e: unknown) {
      console.warn('client/document connect check:', (e as Error)?.message || e);
    }

    const { buildClientPaymentOptions } = await import('@/lib/client-payment-options');
    const paymentOptions = buildClientPaymentOptions({
      stripeReady,
      paymentSettings: profile.paymentSettings || {},
      amount: due.amountDueNow,
      invoiceNumber: String(invoiceNumber),
      company,
      label: due.payLabel,
      feePercentRate: feePercent,
      chargeFees,
    });

    // Certificate of Insurance — signed URL for client view (only if uploaded)
    let hasCertificate = false;
    let certificateUrl = '';
    let certificateIsPdf = false;
    const certRef = String(profile.certificateUrl || '').trim();
    if (certRef) {
      certificateIsPdf = isMediaPdfRef(certRef);
      // Only the contractor's own folder (never another account's file).
      const storagePath = ownedMediaPath(certRef, [uid]);
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

    // Site photos + before/after concept renderings for THIS document only (owner folder,
    // short-lived signed URLs; storage paths never leave the server).
    let media: ClientMediaPayload = { photos: [], renderings: [], expiresAt: null };
    try {
      const plan = planClientMedia(row, uid, settingsProfile);
      media = await signClientMedia(plan, async (paths, ttl) => {
        const { data, error } = await admin.storage.from('media').createSignedUrls(paths, ttl);
        if (error) throw error;
        return data as Array<{ path: string | null; signedUrl: string | null; error?: unknown }>;
      });
    } catch (e: unknown) {
      console.warn('client/document media:', (e as Error)?.message || e);
    }

    // Per-line photos (items[n].photos): same owner-folder check + short-lived signed URLs,
    // keyed by the same line id the items list below uses.
    try {
      const ttl = CLIENT_MEDIA_LIMITS.signedUrlTtlSec;
      const linePhotos = await signClientLinePhotos(
        planClientLinePhotos(
          String(row.user_id || '').trim() === uid ? stripItemTranslations(items) : [],
          uid,
          40
        ),
        async (paths, ttlSec) => {
          const { data, error } = await admin.storage.from('media').createSignedUrls(paths, ttlSec);
          if (error) throw error;
          return data as Array<{ path: string | null; signedUrl: string | null; error?: unknown }>;
        },
        ttl
      );
      if (Object.keys(linePhotos).length > 0) {
        media = {
          ...media,
          linePhotos,
          expiresAt: media.expiresAt || new Date(Date.now() + ttl * 1000).toISOString(),
        };
      }
    } catch (e: unknown) {
      console.warn('client/document line photos:', (e as Error)?.message || e);
    }

    return NextResponse.json({
      ok: true,
      fromDb: true,
      media,
      documentType: due.documentType,
      invoiceNumber,
      jobName: row.jobName || row.jobname || 'Your project',
      company,
      companyPhone: profile.phone || '',
      companyEmail: profile.email || '',
      clientEmail: (Array.isArray(row.emails) ? row.emails : [])
        .map((e: unknown) => String(e || '').trim())
        .find((e: string) => e.includes('@') && e.toLowerCase() !== String(profile.email || '').trim().toLowerCase()) || '',
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
      termsDisplayMode: profile.termsDisplayMode === 'printed' ? 'printed' : 'link',
      chargeCCFee: chargeFees,
      ccFeePercentage: feePercent,
      paymentOptions,
      stripeReady,
      ...((a) => ({
        estimateApproved: Boolean(a.approvedAt),
        approvedAt: a.approvedAt,
        approvedBy: a.approvedBy,
      }))(readEstimateApproval(row)),
      hasCertificate,
      certificateUrl,
      certificateIsPdf,
      taxRate: Number(row.taxRate ?? row.taxrate) || 0,
      isTaxExempt: !!(row.isTaxExempt ?? row.istaxexempt),
      taxesEnabled: profile.taxesEnabled !== false,
      // Whitelist only — never forward internal translation fields to the client page.
      items: stripItemTranslations(items).slice(0, 40).map((it: any, index: number) => {
        const mapped = {
          id: lineOptionId(it, index),
          description: String(it.description || 'Line item').slice(0, 200),
          qty: Number(it.qty) || 0,
          total: Number(it.total) || Number(it.qty || 0) * Number(it.price || 0),
          optional: isOptionalLine(it),
          clientSelected: isClientSelectedOption(it),
        };
        for (const key of ITEM_TRANSLATION_KEYS) delete (mapped as any)[key];
        return mapped;
      }),
    }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (e: any) {
    console.error('client/document:', e);
    return NextResponse.json({ error: 'Failed to load' }, { status: 500 });
  }
}
