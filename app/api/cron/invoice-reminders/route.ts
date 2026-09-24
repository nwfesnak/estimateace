import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { sendEmailNotification, sendSmsNotification } from '@/lib/notifications';
import { createClientActionToken } from '@/lib/client-action-token';
import { getAppUrl } from '@/lib/stripe-server';
import { computeDocumentGrandTotal } from '@/lib/document-totals';
import {
  invoiceReminderDue,
  isInvoiceDocument,
  isInvoiceMarkedPaid,
  profileOf,
  readInvoiceReminderCount,
  recipientEmails,
  recipientPhones,
} from '@/lib/invoice-reminders';

export const maxDuration = 60;

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
 * Daily job: unpaid sent invoices get a client email and text
 * 2 days after send, then every 2 days until marked paid.
 */
export async function GET(request: NextRequest) {
  const cronSecret = (process.env.CRON_SECRET || '').trim();
  const authHeader = request.headers.get('authorization');
  const isVercelCron = request.headers.get('x-vercel-cron') === '1';

  if (!cronSecret) {
    if (process.env.NODE_ENV === 'production' || process.env.VERCEL) {
      return NextResponse.json(
        { error: 'CRON_SECRET is not configured. Refusing to run invoice reminders.' },
        { status: 503 }
      );
    }
  } else if (authHeader !== `Bearer ${cronSecret}` && !isVercelCron) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      { error: 'Supabase service role not configured for invoice reminders.' },
      { status: 500 }
    );
  }

  const { data, error } = await admin.from('estimates').select('*').limit(2000);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const appUrl = getAppUrl(request.url);
  const nowIso = new Date().toISOString();
  const summary = {
    checked: 0,
    due: 0,
    sent: 0,
    skipped: 0,
    errors: [] as string[],
  };

  for (const row of data || []) {
    if (!isInvoiceDocument(row) || isInvoiceMarkedPaid(row)) continue;
    summary.checked += 1;
    if (!invoiceReminderDue(row)) {
      summary.skipped += 1;
      continue;
    }

    const { data: fresh, error: freshError } = await admin
      .from('estimates')
      .select('*')
      .eq('id', row.id)
      .maybeSingle();
    const current = fresh || row;
    if (freshError || !invoiceReminderDue(current) || isInvoiceMarkedPaid(current)) {
      summary.skipped += 1;
      continue;
    }

    summary.due += 1;
    const profile = profileOf(current);
    const company = String(profile.company || 'Your contractor').trim() || 'Your contractor';
    const invoiceNumber = String(
      current.invoiceNumber || current.invoicenumber || current.id || 'Invoice'
    );
    const jobName = String(current.jobName || current.jobname || 'your project');
    let items = current.items;
    if (typeof items === 'string') {
      try {
        items = JSON.parse(items);
      } catch {
        items = [];
      }
    }
    const total = computeDocumentGrandTotal({
      ...current,
      items: Array.isArray(items) ? items : [],
    });
    const paid = Number(current.amountPaid ?? current.amountpaid) || 0;
    const balance = Math.max(0, Math.round((total - paid) * 100) / 100);
    const companyPhone = String(profile.phone || '').trim();
    const companyEmail = String(profile.email || '').trim();

    let actionUrl = '';
    try {
      const token = createClientActionToken({
        uid: String(current.user_id),
        inv: String(current.id || invoiceNumber),
        typ: 'invoice',
        expDays: 60,
      });
      actionUrl = `${appUrl}/client/approve?token=${encodeURIComponent(token)}`;
    } catch (e: any) {
      summary.errors.push(`${invoiceNumber}: ${e?.message || 'Could not build pay link'}`);
      continue;
    }

    const emails = recipientEmails(current);
    const phones = recipientPhones(current);
    if (emails.length === 0 && phones.length === 0) {
      summary.errors.push(`${invoiceNumber}: no client email or phone`);
      summary.skipped += 1;
      continue;
    }

    const subject = `Reminder: Invoice ${invoiceNumber} from ${company}`;
    const text = [
      `${company}: this is a reminder that invoice ${invoiceNumber} for ${jobName} is still unpaid.`,
      `Balance due: ${money(balance)}.`,
      `View and pay: ${actionUrl}`,
      companyPhone ? `Call ${companyPhone}.` : '',
      'Reminders repeat every 2 days until the invoice is marked paid.',
    ]
      .filter(Boolean)
      .join('\n');

    const html = `<div style="font-family:Arial,sans-serif;color:#0f172a;line-height:1.45">
      <p style="margin:0 0 8px;">${escapeHtml(company)} sent a reminder for invoice <strong>${escapeHtml(invoiceNumber)}</strong>${jobName ? ` (${escapeHtml(jobName)})` : ''}.</p>
      <p style="margin:0 0 12px;font-size:18px;"><strong>Balance due: ${money(balance)}</strong></p>
      <p style="margin:0 0 16px;"><a href="${escapeHtml(actionUrl)}" style="display:inline-block;background:#0f766e;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:700;">View and pay invoice</a></p>
      <p style="margin:0;font-size:13px;color:#475569;">This reminder repeats every 2 days until the invoice is marked paid.${companyPhone ? ` Call ${escapeHtml(companyPhone)}.` : ''}</p>
    </div>`;

    const smsBody = `${company}: Reminder — invoice ${invoiceNumber} for ${jobName} is unpaid. Balance ${money(balance)}. Pay: ${actionUrl}${companyPhone ? ` Call ${companyPhone}.` : ''} Reply STOP to opt out.`;

    let notified = false;
    for (const email of emails) {
      const result = await sendEmailNotification(email, subject, text, {
        html,
        replyTo: companyEmail,
        companyName: company,
      });
      if (result.ok) notified = true;
      else if (result.error) summary.errors.push(`${invoiceNumber} email ${email}: ${result.error}`);
    }
    for (const phone of phones) {
      const result = await sendSmsNotification(phone, smsBody);
      if (result.ok) notified = true;
      else if (result.error) summary.errors.push(`${invoiceNumber} sms ${phone}: ${result.error}`);
    }

    if (!notified) {
      summary.skipped += 1;
      continue;
    }

    const nextProfile = {
      ...profile,
      _invoiceLastReminderAt: nowIso,
      _invoiceReminderCount: readInvoiceReminderCount(current) + 1,
    };
    const { error: saveError } = await admin
      .from('estimates')
      .update({ profile: nextProfile, updated_at: nowIso })
      .eq('id', current.id)
      .eq('user_id', current.user_id);
    if (saveError) {
      summary.errors.push(`${invoiceNumber}: sent but could not save reminder time (${saveError.message})`);
    }
    summary.sent += 1;
  }

  return NextResponse.json({ ok: true, ...summary });
}
