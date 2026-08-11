import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/supabase/auth-user';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { sendEmailNotification, sendSmsNotification } from '@/lib/notifications';
import {
  formatItemBreakdownHtml,
  formatItemBreakdownText,
  type EmailBreakdownSettings,
} from '@/lib/email-document-breakdown';
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
    // Example card fee for email (actual fee shown per method on pay page)
    const exampleFee = computeProcessingFee(amountDueNow, { method: 'stripe' });

    const rawBreakdown = body.breakdownSettings || body.estimateBreakdownSettings || {};
    const breakdownSettings: EmailBreakdownSettings = {
      showMaterialBreakdownOnEstimate: !!rawBreakdown.showMaterialBreakdownOnEstimate,
      showLaborBreakdownOnEstimate: !!rawBreakdown.showLaborBreakdownOnEstimate,
      showCostBreakdownOnEstimate: !!rawBreakdown.showCostBreakdownOnEstimate,
    };

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

    const appUrl = getAppUrl(request.url);
    const actionToken = createClientActionToken({
      uid: ownerUserId,
      inv: invoiceNumber,
      typ: documentType,
      expDays: 60,
    });
    const actionUrl = `${appUrl}/client/approve?token=${encodeURIComponent(actionToken)}`;
    const termsUrl = `${appUrl}/client/terms?token=${encodeURIComponent(actionToken)}`;

    const ctaLabel =
      documentType === 'estimate'
        ? amountDueNow >= 0.5
          ? `Approve & pay deposit (${money(amountDueNow)} + fees)`
          : 'Approve this estimate'
        : amountDueNow >= 0.5
          ? amountPaid > 0
            ? `Pay remaining balance (${money(amountDueNow)} + fees)`
            : `Pay invoice total (${money(amountDueNow)} + fees)`
          : 'View invoice & pay';

    const location = [address, city, state, zipCode].filter(Boolean).join(', ');
    const lineLines = items
      .slice(0, 40)
      .map((it, i) => {
        const desc = String(it.description || 'Line item').slice(0, 200);
        const total = money(Number(it.total) || Number(it.qty || 0) * Number(it.price || 0));
        const header = `${i + 1}. ${desc} — ${total}`;
        const breakdown = formatItemBreakdownText(it, breakdownSettings);
        return breakdown ? `${header}\n${breakdown}` : header;
      })
      .join('\n\n');

    const subject = `${docLabel} ${invoiceNumber} from ${company}`;

    const text = [
      `${company} sent you a ${docLabel.toLowerCase()}.`,
      '',
      `${docLabel} #: ${invoiceNumber}`,
      `Client: ${jobName}`,
      date ? `Date: ${date}` : '',
      location ? `Job address: ${location}` : '',
      '',
      'Line items:',
      lineLines || '(see contractor for details)',
      '',
      showDiscount ? `Subtotal: ${money(subtotalBeforeDiscount)}` : '',
      showDiscount
        ? `Discount (${discountDescription}${
            discountType === 'percent' && discountValue > 0 ? ` ${discountValue}%` : ''
          }): -${money(discountAmount)}`
        : '',
      showDiscount && taxAmount > 0 ? `Tax: ${money(taxAmount)}` : '',
      `Grand total: ${money(grandTotal)}`,
      amountPaid > 0 ? `Amount paid (e.g. deposit): ${money(amountPaid)}` : '',
      documentType === 'estimate' && depositDue >= 0.5
        ? `Deposit due now (${depositPercent}%): ${money(depositDue)}`
        : '',
      documentType === 'invoice'
        ? `${payLabel}: ${money(amountDueNow)}`
        : depositDue < 0.5
          ? `Amount due: ${money(amountDueNow)}`
          : '',
      amountDueNow >= 0.5
        ? `Card pay example: ${money(exampleFee.totalAmount)} (includes ~${money(exampleFee.feeAmount)} processing fee)`
        : '',
      '',
      `${ctaLabel}:`,
      actionUrl,
      '',
      terms ? `Terms & Conditions: ${termsUrl}` : '',
      '',
      'Questions? Contact:',
      companyPhone ? `Phone: ${companyPhone}` : '',
      companyEmail ? `Email: ${companyEmail}` : '',
      '',
      '— Sent via EstimateAce',
    ]
      .filter((line) => line !== '')
      .join('\n');

    const rowsHtml = items
      .slice(0, 40)
      .map((it) => {
        const desc = escapeHtml(String(it.description || 'Line item').slice(0, 200));
        const qty = Number(it.qty) || 0;
        const total = money(Number(it.total) || qty * Number(it.price || 0));
        const breakdownHtml = formatItemBreakdownHtml(it, breakdownSettings);
        return `<tr>
          <td style="padding:8px;border-bottom:1px solid #e2e8f0;vertical-align:top;">
            <div>${desc}</div>
            ${breakdownHtml}
          </td>
          <td style="padding:8px;border-bottom:1px solid #e2e8f0;text-align:right;vertical-align:top;">${qty}</td>
          <td style="padding:8px;border-bottom:1px solid #e2e8f0;text-align:right;vertical-align:top;">${total}</td>
        </tr>`;
      })
      .join('');

    const termsDisclosureHtml = terms
      ? `
  <div style="margin:18px 0 0;padding:14px 16px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;font-size:14px;color:#334155;text-align:center;">
    <a href="${escapeHtml(termsUrl)}"
       style="color:#0f766e;font-weight:700;text-decoration:underline;font-size:15px;">
      View Terms &amp; Conditions
    </a>
    <p style="margin:8px 0 0;font-size:11px;color:#64748b;">Opens full terms in your browser (not pasted below).</p>
  </div>`
      : '';

    const ctaHtml = `
  <div style="margin:28px 0;text-align:center;padding:20px;background:#ecfdf5;border:2px dashed #10b981;border-radius:16px;">
    ${
      documentType === 'estimate' && depositDue >= 0.5
        ? `<p style="margin:0 0 8px;font-size:15px;color:#065f46;">Deposit due now: <strong>${money(depositDue)}</strong> (${depositPercent}% of ${money(grandTotal)}). Processing fees apply at checkout.</p>`
        : documentType === 'estimate'
          ? `<p style="margin:0 0 8px;font-size:15px;color:#065f46;">Ready to move forward? Approve this estimate online.</p>`
          : amountPaid > 0
            ? `<p style="margin:0 0 8px;font-size:15px;color:#065f46;">Balance due (total ${money(grandTotal)} − paid ${money(amountPaid)}): <strong>${money(amountDueNow)}</strong>. Processing fees apply at payment.</p>`
            : `<p style="margin:0 0 8px;font-size:15px;color:#065f46;">Total due: <strong>${money(amountDueNow)}</strong>. Processing fees apply at payment.</p>`
    }
    <a href="${escapeHtml(actionUrl)}"
       style="display:inline-block;background:#10b981;color:#ffffff;text-decoration:none;font-weight:700;font-size:16px;padding:14px 28px;border-radius:12px;margin-top:8px;">
      ${escapeHtml(ctaLabel)}
    </a>
    <p style="margin:12px 0 0;font-size:12px;color:#64748b;">Or open this link:<br/><a href="${escapeHtml(actionUrl)}" style="color:#0f766e;word-break:break-all;">${escapeHtml(actionUrl)}</a></p>
    ${termsDisclosureHtml}
  </div>`;

    const html = `<!DOCTYPE html>
<html><body style="font-family:system-ui,Segoe UI,sans-serif;color:#0f172a;line-height:1.5;max-width:640px;margin:0 auto;padding:24px;">
  <h1 style="font-size:22px;margin:0 0 8px;">${escapeHtml(docLabel)} from ${escapeHtml(company)}</h1>
  <p style="color:#64748b;margin:0 0 20px;">${escapeHtml(docLabel)} # ${escapeHtml(invoiceNumber)}${date ? ` · ${escapeHtml(date)}` : ''}</p>
  <p style="margin:0 0 8px;"><strong>Client:</strong> ${escapeHtml(jobName)}</p>
  ${location ? `<p style="margin:0 0 16px;"><strong>Job address:</strong> ${escapeHtml(location)}</p>` : ''}
  <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:14px;">
    <thead>
      <tr style="background:#f1f5f9;">
        <th style="text-align:left;padding:8px;">Description</th>
        <th style="text-align:right;padding:8px;">Qty</th>
        <th style="text-align:right;padding:8px;">Total</th>
      </tr>
    </thead>
    <tbody>
      ${rowsHtml || '<tr><td colspan="3" style="padding:8px;">See contractor for full details</td></tr>'}
    </tbody>
  </table>
  <div style="margin:16px 0 8px;font-size:14px;">
    ${
      showDiscount
        ? `<p style="margin:0 0 4px;color:#475569;">Subtotal: ${money(subtotalBeforeDiscount)}</p>
    <p style="margin:0 0 4px;color:#b91c1c;font-weight:600;">
      Discount — ${escapeHtml(discountDescription)}${
            discountType === 'percent' && discountValue > 0
              ? ` (${discountValue}%)`
              : ''
          }: −${money(discountAmount)}
    </p>
    ${taxAmount > 0 ? `<p style="margin:0 0 4px;color:#475569;">Tax: ${money(taxAmount)}</p>` : ''}`
        : ''
    }
    <p style="font-size:18px;font-weight:700;margin:8px 0 4px;">Grand total: ${money(grandTotal)}</p>
    ${amountPaid > 0 ? `<p style="margin:0 0 4px;">Amount paid (deposit etc.): ${money(amountPaid)}</p>` : ''}
    ${
      documentType === 'estimate' && depositDue >= 0.5
        ? `<p style="margin:0 0 4px;color:#065f46;font-weight:600;">Deposit due now (${depositPercent}%): ${money(depositDue)}</p>
    <p style="margin:0 0 8px;color:#64748b;font-size:13px;">Remaining after deposit: ${money(Math.max(0, grandTotal - depositDue))}</p>`
        : `<p style="margin:0 0 8px;">${escapeHtml(payLabel)}: <strong>${money(amountDueNow)}</strong></p>`
    }
  </div>
  ${ctaHtml}
  <p style="margin-top:24px;font-size:14px;color:#475569;">
    Questions? ${companyPhone ? `Call ${escapeHtml(companyPhone)}` : ''}${companyPhone && companyEmail ? ' · ' : ''}${companyEmail ? `Email ${escapeHtml(companyEmail)}` : ''}
  </p>
  <p style="font-size:11px;color:#94a3b8;margin-top:32px;">Sent via EstimateAce</p>
</body></html>`;

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

    const smsBody = `${company}: ${docLabel} ${invoiceNumber} for ${jobName}. Total ${money(grandTotal)}. ${ctaLabel}: ${actionUrl}${companyPhone ? ` Call ${companyPhone}.` : ''}`;
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
