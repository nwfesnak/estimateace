import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/supabase/auth-user';
import { sendEmailNotification, sendSmsNotification } from '@/lib/notifications';

type LineItem = {
  description?: string;
  qty?: number;
  unit?: string;
  price?: number;
  total?: number;
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
 * Uses Resend + Twilio env vars on the server.
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

    if (emails.length === 0 && phones.length === 0) {
      return NextResponse.json(
        { error: 'Select at least one email or phone number.' },
        { status: 400 }
      );
    }

    const location = [address, city, state, zipCode].filter(Boolean).join(', ');
    const lineLines = items
      .slice(0, 40)
      .map((it, i) => {
        const desc = String(it.description || 'Line item').slice(0, 200);
        const total = money(Number(it.total) || Number(it.qty || 0) * Number(it.price || 0));
        return `${i + 1}. ${desc} — ${total}`;
      })
      .join('\n');

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
      `Grand total: ${money(grandTotal)}`,
      amountPaid > 0 ? `Amount paid: ${money(amountPaid)}` : '',
      `Balance due: ${money(balanceDue)}`,
      '',
      terms ? `Terms:\n${terms.slice(0, 1500)}` : '',
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
        return `<tr>
          <td style="padding:8px;border-bottom:1px solid #e2e8f0;">${desc}</td>
          <td style="padding:8px;border-bottom:1px solid #e2e8f0;text-align:right;">${qty}</td>
          <td style="padding:8px;border-bottom:1px solid #e2e8f0;text-align:right;">${total}</td>
        </tr>`;
      })
      .join('');

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
  <p style="font-size:18px;font-weight:700;margin:16px 0 4px;">Grand total: ${money(grandTotal)}</p>
  ${amountPaid > 0 ? `<p style="margin:0 0 4px;">Amount paid: ${money(amountPaid)}</p>` : ''}
  <p style="margin:0 0 20px;">Balance due: <strong>${money(balanceDue)}</strong></p>
  ${
    terms
      ? `<div style="margin:20px 0;padding:12px;background:#f8fafc;border-radius:8px;font-size:13px;white-space:pre-wrap;">${escapeHtml(terms.slice(0, 2000))}</div>`
      : ''
  }
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
      });
      if (result.ok) emailsSent.push(email);
      else errors.push(`${email}: ${result.error}`);
    }

    const smsBody = `${company}: ${docLabel} ${invoiceNumber} for ${jobName}. Total ${money(grandTotal)}, balance due ${money(balanceDue)}.${companyPhone ? ` Call ${companyPhone}.` : ''}`;
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
    });
  } catch (e: any) {
    console.error('documents/send:', e);
    return NextResponse.json({ error: e?.message || 'Send failed' }, { status: 500 });
  }
}
