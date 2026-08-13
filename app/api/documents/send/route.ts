import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/supabase/auth-user';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { sendEmailNotification, sendSmsNotification } from '@/lib/notifications';
import { createClientActionToken } from '@/lib/client-action-token';
import { getAppUrl } from '@/lib/stripe-server';

type LineItem = {
  description?: string;
  qty?: number;
  unit?: string;
  price?: number;
  total?: number;
  materialsList?: any[];
  materialBreakdown?: any;
  laborBreakdown?: any;
  breakdownUserEdited?: boolean;
  breakdownLocked?: boolean;
  [key: string]: any;
};

function money(n: number) {
  return `$${Number(n || 0).toFixed(2)}`;
}

function escapeHtml(s: string) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Send estimate/invoice summary to client emails (and optional SMS).
 * Includes materials/labor/cost breakdowns when those toggles are on for the document.
 */
export async function POST(request: NextRequest) {
  try {
    const { user, error: authError } = await getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: authError || 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));
    const emails: string[] = Array.isArray(body.emails)
      ? body.emails.map((e: any) => String(e || '').trim()).filter(Boolean)
      : [];
    const phones: string[] = Array.isArray(body.phones)
      ? body.phones.map((p: any) => String(p || '').trim()).filter(Boolean)
      : [];

    const documentType = body.documentType === 'invoice' ? 'invoice' : 'estimate';
    const docLabel = documentType === 'invoice' ? 'Invoice' : 'Estimate';
    const invoiceNumber = String(body.invoiceNumber || '').trim() || 'N/A';
    const jobName = String(body.jobName || '').trim() || 'Client';
    const company = String(body.company || '').trim() || 'Your contractor';
    const companyPhone = String(body.companyPhone || '').trim();
    const companyEmail = String(body.companyEmail || '').trim();
    const address = String(body.address || '').trim();
    const city = String(body.city || '').trim();
    const state = String(body.state || '').trim();
    const zipCode = String(body.zipCode || '').trim();
    const date = String(body.date || '').trim();
    const terms = String(body.terms || '').trim();
    const grandTotal = Number(body.grandTotal) || 0;
    const amountPaid = Number(body.amountPaid) || 0;
    const balanceDue = Math.max(0, grandTotal - amountPaid);
    const items: LineItem[] = Array.isArray(body.items) ? body.items : [];
    const subtotalBeforeDiscount = Math.max(
      0,
      Number(body.subtotalBeforeDiscount) ||
        items.reduce(
          (s, it) => s + (Number(it.total) || Number(it.qty || 0) * Number(it.price || 0)),
          0
        )
    );
    const discountAmount = Math.max(0, Number(body.discountAmount) || 0);
    const discountDescription = String(body.discountDescription || '').trim() || 'Discount';
    const discountType = body.discountType === 'percent' ? 'percent' : 'dollar';
    const discountValue = Number(body.discountValue) || 0;
    const taxAmount = Math.max(0, Number(body.taxAmount) || 0);
    const showDiscount = discountAmount > 0.005;
    const depositPercent = Math.max(0, Number(body.depositPercent) || 0);
    const showDepositOnApproval = body.showDepositOnApproval !== false;
    // Card payments always may include a processing fee; Zelle / mail never do
    const chargeCCFee = true;
    const ccFeePercentage =
      Number(body.ccFeePercentage) > 0 ? Number(body.ccFeePercentage) : 2.9;
    const { resolveAmountDue, computeProcessingFee } = await import('@/lib/stripe-fees');
    const due = resolveAmountDue({
      documentType,
      grandTotal,
      amountPaid,
      depositPercent,
      showDepositOnApproval,
    });
    const depositDue = due.depositDue;
    const amountDueNow = due.amountDueNow;
    const payLabel = due.payLabel;
    // Example card fee only when company charges fees (Zelle / mail check never have fees)
    const exampleFee = computeProcessingFee(amountDueNow, {
      method: 'stripe',
      chargeFees: chargeCCFee,
      percentRate: chargeCCFee ? ccFeePercentage : 0,
      fixedFee: chargeCCFee ? undefined : 0,
    });

    if (emails.length === 0 && phones.length === 0) {
      return NextResponse.json(
        { error: 'Select at least one email or phone number.' },
        { status: 400 }
      );
    }

    // Workspace owner (crew → owner) for client action links
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

    // Certificate of Insurance — show email button only if contractor has one uploaded
    let hasCertificate = !!String(body.certificateUrl || '').trim();
    if (!hasCertificate && admin) {
      try {
        const { data: settingsRow } = await admin
          .from('estimates')
          .select('profile')
          .eq('id', `SETTINGS-${ownerUserId}`)
          .maybeSingle();
        hasCertificate = !!String((settingsRow?.profile as any)?.certificateUrl || '').trim();
      } catch {
        /* optional */
      }
    }

    const appUrl = getAppUrl(request.url);
    const actionToken = createClientActionToken({
      uid: ownerUserId,
      inv: invoiceNumber,
      typ: documentType,
      expDays: 60,
    });
    const actionUrl = `${appUrl}/client/approve?token=${encodeURIComponent(actionToken)}`;
    const termsUrl = `${appUrl}/client/terms?token=${encodeURIComponent(actionToken)}`;
    const certificateUrl = `${appUrl}/client/certificate?token=${encodeURIComponent(actionToken)}`;

    // Short button labels — full amount shown as "Total due" line above buttons
    const payButtonLabelHtml =
      documentType === 'estimate'
        ? amountDueNow >= 0.5
          ? 'Approve &amp; make payment'
          : 'Approve estimate'
        : amountDueNow >= 0.5
          ? 'Make payment'
          : 'View invoice';
    const payButtonLabelPlain =
      documentType === 'estimate'
        ? amountDueNow >= 0.5
          ? 'Approve & make payment'
          : 'Approve estimate'
        : amountDueNow >= 0.5
          ? 'Make payment'
          : 'View invoice';

    const totalDueLabel =
      documentType === 'estimate' && depositDue >= 0.5
        ? 'Deposit due'
        : amountPaid > 0
          ? 'Balance due'
          : 'Total due';

    const totalDueAmount =
      documentType === 'estimate' && depositDue >= 0.5 ? depositDue : amountDueNow;

    const location = [address, city, state, zipCode].filter(Boolean).join(', ');
    const lineLines = items
      .slice(0, 20)
      .map((it, i) => {
        const desc = String(it.description || 'Line item').slice(0, 120);
        const total = money(Number(it.total) || Number(it.qty || 0) * Number(it.price || 0));
        return `${i + 1}. ${desc} — ${total}`;
      })
      .join('\n');

    const subject = `${docLabel} ${invoiceNumber} from ${company}`;

    // Keep plain text short so nothing important is clipped
    let text = [
      `${company} sent you a ${docLabel.toLowerCase()}.`,
      `${docLabel} # ${invoiceNumber}${date ? ` · ${date}` : ''}`,
      `Client: ${jobName}`,
      location ? `Job: ${location}` : '',
      '',
      `${totalDueLabel}: ${money(totalDueAmount)}`,
      amountDueNow >= 0.5 && chargeCCFee && exampleFee.feeAmount > 0
        ? `(Card payments may include a processing fee. Example card total: ${money(exampleFee.totalAmount)}. Zelle and mail check have no processing fee.)`
        : '',
      '',
      `Pay / approve: ${actionUrl}`,
      terms ? `Terms & Conditions: ${termsUrl}` : '',
      hasCertificate ? `Certificate of Insurance: ${certificateUrl}` : '',
      '',
      `Grand total: ${money(grandTotal)}`,
      amountPaid > 0 ? `Already paid: ${money(amountPaid)}` : '',
      lineLines ? `\nItems:\n${lineLines}` : '',
      '',
      companyPhone ? `Phone: ${companyPhone}` : '',
      companyEmail ? `Email: ${companyEmail}` : '',
      '— EstimateAce',
    ]
      .filter((line) => line !== '')
      .join('\n');

    // Compact line list (no long breakdowns in email — keeps Total due + buttons above Gmail clip)
    const rowsHtml = items
      .slice(0, 15)
      .map((it) => {
        const desc = escapeHtml(String(it.description || 'Line item').slice(0, 100));
        const total = money(Number(it.total) || Number(it.qty || 0) * Number(it.price || 0));
        return `<tr>
          <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;font-size:13px;">${desc}</td>
          <td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;text-align:right;font-size:13px;white-space:nowrap;">${total}</td>
        </tr>`;
      })
      .join('');

    // Optional media (kept short — below main CTA so primary actions stay visible)
    const sitePhotoUrls: string[] = Array.isArray(body.sitePhotoUrls)
      ? body.sitePhotoUrls
          .map((u: any) => String(u || '').trim())
          .filter((u: string) => /^https?:\/\//i.test(u))
          .slice(0, 8)
      : [];
    const clientVideoUrls: string[] = Array.isArray(body.videoUrls)
      ? body.videoUrls
          .map((u: any) => String(u || '').trim())
          .filter((u: string) => /^https?:\/\//i.test(u))
          .slice(0, 6)
      : [];
    const jobRenderings: Array<{
      lineDescription: string;
      notes: string;
      beforeUrl: string;
      afterUrl: string;
    }> = Array.isArray(body.jobRenderings)
      ? body.jobRenderings
          .slice(0, 6)
          .map((r: any) => ({
            lineDescription: String(r?.lineDescription || '').slice(0, 200),
            notes: String(r?.notes || '').slice(0, 120),
            beforeUrl: String(r?.beforeUrl || '').trim(),
            afterUrl: String(r?.afterUrl || '').trim(),
          }))
          .filter((r: any) => r.beforeUrl || r.afterUrl)
      : [];

    let mediaHtml = '';
    if (sitePhotoUrls.length > 0) {
      const thumbs = sitePhotoUrls
        .map(
          (url) =>
            `<img src="${escapeHtml(url)}" alt="Site photo" width="96" height="96" style="object-fit:cover;border-radius:8px;border:1px solid #e2e8f0;width:96px;height:96px;margin:3px;" />`
        )
        .join('');
      mediaHtml += `<div style="margin-top:20px;"><p style="font-size:13px;font-weight:600;margin:0 0 8px;">Site photos</p>${thumbs}</div>`;
    }
    if (jobRenderings.length > 0) {
      const blocks = jobRenderings
        .map((r) => {
          const after = r.afterUrl
            ? `<img src="${escapeHtml(r.afterUrl)}" alt="After" width="140" style="max-width:45%;border-radius:8px;border:1px solid #ddd6fe;" />`
            : '';
          const before = r.beforeUrl
            ? `<img src="${escapeHtml(r.beforeUrl)}" alt="Before" width="140" style="max-width:45%;border-radius:8px;border:1px solid #e2e8f0;" />`
            : '';
          return `<div style="margin:8px 0;">${before}${after}</div>`;
        })
        .join('');
      mediaHtml += `<div style="margin-top:16px;"><p style="font-size:13px;font-weight:600;margin:0 0 4px;">AI job renderings</p><p style="font-size:11px;color:#92400e;margin:0 0 8px;">AI previews only — actual results may vary.</p>${blocks}</div>`;
    }
    if (clientVideoUrls.length > 0) {
      mediaHtml += `<div style="margin-top:16px;"><p style="font-size:13px;font-weight:600;margin:0 0 6px;">Videos</p><p style="font-size:12px;color:#475569;margin:0;">${clientVideoUrls.length} video(s) available when you open the payment page.</p></div>`;
    }

    /*
     * Simple email layout:
     * 1) Header  2) Total due  3) Pay button  4) Terms button
     * All near the top so Gmail "…" clip is less likely to hide actions.
     * No raw URL hyperlinks in HTML.
     */
    const actionButtonsHtml = `
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 20px;">
    <tr>
      <td style="background:#ecfdf5;border:2px solid #10b981;border-radius:16px;padding:20px 16px;text-align:center;">
        <p style="margin:0 0 4px;font-size:13px;color:#065f46;font-weight:600;text-transform:uppercase;letter-spacing:0.03em;">
          ${escapeHtml(totalDueLabel)}
        </p>
        <p style="margin:0 0 16px;font-size:32px;font-weight:800;color:#064e3b;line-height:1.1;">
          ${money(totalDueAmount)}
        </p>
        ${
          amountDueNow >= 0.5 && chargeCCFee && exampleFee.feeAmount > 0
            ? `<p style="margin:0 0 16px;font-size:12px;color:#64748b;">Card / Venmo / PayPal may include a processing fee at checkout. Zelle and mail check have no processing fee.</p>`
            : ''
        }
        <!--[if mso]>
        <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" href="${escapeHtml(actionUrl)}" style="height:48px;v-text-anchor:middle;width:260px;" arcsize="12%" fillcolor="#10b981" stroke="f">
          <w:anchorlock/>
          <center style="color:#ffffff;font-family:sans-serif;font-size:16px;font-weight:bold;">${payButtonLabelPlain}</center>
        </v:roundrect>
        <![endif]-->
        <!--[if !mso]><!-- -->
        <a href="${escapeHtml(actionUrl)}"
           style="display:inline-block;background:#10b981;color:#ffffff !important;text-decoration:none;font-weight:700;font-size:16px;padding:14px 28px;border-radius:12px;mso-hide:all;">
          ${payButtonLabelHtml}
        </a>
        <!--<![endif]-->
        ${
          terms
            ? `
        <div style="height:12px;line-height:12px;font-size:12px;">&nbsp;</div>
        <!--[if mso]>
        <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" href="${escapeHtml(termsUrl)}" style="height:44px;v-text-anchor:middle;width:260px;" arcsize="12%" fillcolor="#0f766e" stroke="f">
          <w:anchorlock/>
          <center style="color:#ffffff;font-family:sans-serif;font-size:15px;font-weight:bold;">View Terms &amp; Conditions</center>
        </v:roundrect>
        <![endif]-->
        <!--[if !mso]><!-- -->
        <a href="${escapeHtml(termsUrl)}"
           style="display:inline-block;background:#0f766e;color:#ffffff !important;text-decoration:none;font-weight:700;font-size:15px;padding:12px 24px;border-radius:12px;mso-hide:all;">
          View Terms &amp; Conditions
        </a>
        <!--<![endif]-->
        `
            : ''
        }
        ${
          hasCertificate
            ? `
        <div style="height:12px;line-height:12px;font-size:12px;">&nbsp;</div>
        <!--[if mso]>
        <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" href="${escapeHtml(certificateUrl)}" style="height:44px;v-text-anchor:middle;width:260px;" arcsize="12%" fillcolor="#1e40af" stroke="f">
          <w:anchorlock/>
          <center style="color:#ffffff;font-family:sans-serif;font-size:15px;font-weight:bold;">View Certificate of Insurance</center>
        </v:roundrect>
        <![endif]-->
        <!--[if !mso]><!-- -->
        <a href="${escapeHtml(certificateUrl)}"
           style="display:inline-block;background:#1e40af;color:#ffffff !important;text-decoration:none;font-weight:700;font-size:15px;padding:12px 24px;border-radius:12px;mso-hide:all;">
          View Certificate of Insurance
        </a>
        <!--<![endif]-->
        `
            : ''
        }
      </td>
    </tr>
  </table>`;

    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="x-apple-disable-message-reformatting" />
  <title>${escapeHtml(docLabel)} ${escapeHtml(invoiceNumber)}</title>
</head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0f172a;line-height:1.45;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">
    ${escapeHtml(totalDueLabel)} ${money(totalDueAmount)} — ${escapeHtml(company)}
  </div>
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f8fafc;">
    <tr>
      <td style="padding:16px 12px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:16px;border:1px solid #e2e8f0;overflow:hidden;">
          <tr>
            <td style="padding:20px 20px 8px;">
              <p style="margin:0;font-size:13px;color:#64748b;">${escapeHtml(company)}</p>
              <h1 style="font-size:20px;margin:4px 0 0;font-weight:700;color:#0f172a;">
                ${escapeHtml(docLabel)} ${escapeHtml(invoiceNumber)}
              </h1>
              <p style="margin:6px 0 0;font-size:13px;color:#64748b;">
                ${escapeHtml(jobName)}${date ? ` · ${escapeHtml(date)}` : ''}
              </p>
              ${location ? `<p style="margin:4px 0 0;font-size:12px;color:#94a3b8;">${escapeHtml(location)}</p>` : ''}
            </td>
          </tr>
          <tr>
            <td style="padding:8px 16px 4px;">
              ${actionButtonsHtml}
            </td>
          </tr>
          <tr>
            <td style="padding:4px 20px 16px;">
              <p style="margin:0 0 6px;font-size:12px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:0.04em;">Summary</p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
                ${
                  showDiscount
                    ? `<tr><td style="padding:4px 0;font-size:13px;color:#64748b;">Subtotal</td><td style="padding:4px 0;font-size:13px;text-align:right;">${money(subtotalBeforeDiscount)}</td></tr>
                <tr><td style="padding:4px 0;font-size:13px;color:#b91c1c;">Discount</td><td style="padding:4px 0;font-size:13px;text-align:right;color:#b91c1c;">−${money(discountAmount)}</td></tr>`
                    : ''
                }
                ${taxAmount > 0 ? `<tr><td style="padding:4px 0;font-size:13px;color:#64748b;">Tax</td><td style="padding:4px 0;font-size:13px;text-align:right;">${money(taxAmount)}</td></tr>` : ''}
                <tr><td style="padding:6px 0;font-size:15px;font-weight:700;">Grand total</td><td style="padding:6px 0;font-size:15px;font-weight:700;text-align:right;">${money(grandTotal)}</td></tr>
                ${amountPaid > 0 ? `<tr><td style="padding:4px 0;font-size:13px;color:#64748b;">Already paid</td><td style="padding:4px 0;font-size:13px;text-align:right;">${money(amountPaid)}</td></tr>` : ''}
                <tr><td style="padding:8px 0 0;font-size:16px;font-weight:800;color:#065f46;">${escapeHtml(totalDueLabel)}</td><td style="padding:8px 0 0;font-size:16px;font-weight:800;color:#065f46;text-align:right;">${money(totalDueAmount)}</td></tr>
              </table>
            </td>
          </tr>
          ${
            rowsHtml
              ? `<tr>
            <td style="padding:0 20px 16px;">
              <p style="margin:0 0 6px;font-size:12px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:0.04em;">Line items</p>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #e2e8f0;border-radius:8px;">
                <tr style="background:#f8fafc;">
                  <th style="text-align:left;padding:8px;font-size:12px;color:#64748b;">Description</th>
                  <th style="text-align:right;padding:8px;font-size:12px;color:#64748b;">Total</th>
                </tr>
                ${rowsHtml}
              </table>
            </td>
          </tr>`
              : ''
          }
          ${
            mediaHtml
              ? `<tr><td style="padding:0 20px 16px;">${mediaHtml}</td></tr>`
              : ''
          }
          <tr>
            <td style="padding:12px 20px 20px;border-top:1px solid #f1f5f9;">
              <p style="margin:0;font-size:13px;color:#475569;">
                Questions?
                ${companyPhone ? ` Call ${escapeHtml(companyPhone)}` : ''}${
                  companyPhone && companyEmail ? ' · ' : ''
                }${companyEmail ? `Email ${escapeHtml(companyEmail)}` : ''}
              </p>
              <p style="margin:10px 0 0;font-size:11px;color:#94a3b8;">Sent via EstimateAce</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

    const replyTo =
      companyEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(companyEmail)
        ? companyEmail
        : undefined;

    const emailsSent: string[] = [];
    const smsSent: string[] = [];
    const errors: string[] = [];

    for (const email of emails) {
      const result = await sendEmailNotification(email, subject, text, {
        html,
        replyTo,
        // Client inbox shows contractor company, e.g. Mitigation Hero <mitigationhero@estimateace.com>
        companyName: company,
      });
      if (result.ok) emailsSent.push(email);
      else errors.push(`${email}: ${result.error}`);
    }

    const smsBody = `${company}: ${docLabel} ${invoiceNumber} for ${jobName}. ${totalDueLabel} ${money(totalDueAmount)}. ${payButtonLabelPlain}: ${actionUrl}${companyPhone ? ` Call ${companyPhone}.` : ''}`;
    for (const phone of phones) {
      const result = await sendSmsNotification(phone, smsBody);
      if (result.ok) smsSent.push(phone);
      else errors.push(`${phone}: ${result.error}`);
    }

    const anyOk = emailsSent.length > 0 || smsSent.length > 0;
    if (!anyOk) {
      return NextResponse.json(
        {
          error:
            errors[0] ||
            'Nothing was sent. Check RESEND_API_KEY (email) and Twilio (SMS) on Vercel, then redeploy.',
          errors,
          emailsSent,
          smsSent,
        },
        { status: 502 }
      );
    }

    return NextResponse.json({
      ok: true,
      emailsSent,
      smsSent,
      errors,
      partial: errors.length > 0,
      actionUrl,
    });
  } catch (e: any) {
    console.error('documents/send:', e);
    return NextResponse.json({ error: e?.message || 'Send failed' }, { status: 500 });
  }
}
