import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { sendEmailNotification, sendSmsNotification } from '@/lib/notifications';
import { rateLimit, reserveSendQuota } from '@/lib/rate-limit';
import { mergeAppointmentNotify, readNotifyFromEstimate } from '@/lib/appointment-confirm';
import {
  buildClientMorningReminderMessages,
  selectDueClientReminders,
  type ReminderAppointment,
} from '@/lib/client-morning-reminders';

export const maxDuration = 60;

function maskPhone(p: string): string {
  const digits = String(p || '').replace(/\D/g, '');
  return digits.length >= 4 ? `***${digits.slice(-4)}` : '***';
}

/**
 * Hourly Vercel Cron: morning-of text + email to the customer for each appointment
 * scheduled today (company local time). See lib/client-morning-reminders.ts.
 */
export async function GET(request: NextRequest) {
  const cronSecret = (process.env.CRON_SECRET || '').trim();
  const authHeader = request.headers.get('authorization');
  if (!cronSecret) {
    if (process.env.NODE_ENV === 'production' || process.env.VERCEL) {
      return NextResponse.json(
        { error: 'CRON_SECRET is not configured. Refusing to run reminders.' },
        { status: 503 }
      );
    }
  } else if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    return NextResponse.json({ error: 'Supabase service role not configured.' }, { status: 500 });
  }
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  const { data: settingsRows, error } = await supabase
    .from('estimates')
    .select('user_id, profile')
    .eq('jobName', '__settings__');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const now = new Date();
  const summary = { accounts: 0, due: 0, emailsSent: 0, textsSent: 0, skipped: 0, errors: [] as string[] };

  for (const row of settingsRows || []) {
    const ownerId = String(row.user_id || '');
    const profile = (row.profile || {}) as Record<string, unknown>;
    const appointments = (profile._appointments || []) as ReminderAppointment[];
    if (!ownerId || !Array.isArray(appointments) || appointments.length === 0) continue;
    summary.accounts += 1;

    // The estimate holds the freshest notify status (recipients / reschedule).
    const estimateIds = Array.from(
      new Set(appointments.map((a) => String(a?.estimateId || '').trim()).filter(Boolean))
    );
    const estimates = new Map<string, Record<string, unknown>>();
    if (estimateIds.length) {
      const { data: estRows } = await supabase
        .from('estimates')
        .select('id, profile')
        .eq('user_id', ownerId)
        .in('id', estimateIds);
      for (const est of estRows || []) estimates.set(String(est.id), est as Record<string, unknown>);
    }
    const merged = appointments
      .filter((a) => !a?.estimateId || estimates.has(String(a.estimateId)))
      .map((a) => ({
        ...a,
        notify: mergeAppointmentNotify(
          a,
          a.estimateId ? readNotifyFromEstimate(estimates.get(String(a.estimateId))) : undefined
        ),
      }));

    for (const due of selectDueClientReminders(merged, profile, now)) {
      const appt = due.appointment;
      // Atomic once-per-appointment-per-day claim (shared Postgres counter).
      const claim = await rateLimit(`appt-client-reminder:${ownerId}:${appt.id}:${due.dateKey}`, 2 * 24 * 60 * 60, 1);
      if (!claim.allowed) {
        summary.skipped += 1;
        continue;
      }
      summary.due += 1;

      const companyName = String(profile.company || appt.notify?.companyName || 'EstimateAce');
      const messages = buildClientMorningReminderMessages({
        appointmentDateTime: appt.datetime,
        timeZone: due.timeZone,
        companyName,
        companyPhone: String(profile.phone || ''),
        jobName: appt.jobName || appt.notify?.jobName,
        location: appt.notify?.location,
        customerName: appt.notify?.customerName,
        reference: appt.invoiceNumber || appt.estimateId,
      });

      if (due.emails.length && !(await reserveSendQuota(ownerId, 'email', due.emails.length))) {
        const replyTo = String(profile.email || '').trim();
        for (const email of due.emails) {
          const sent = await sendEmailNotification(email, messages.subject, messages.emailText, {
            html: messages.emailHtml,
            companyName,
            replyTo: replyTo || undefined,
            idempotencyKey: `appt-client-reminder:${ownerId}:${appt.id}:${due.dateKey}:email:${email}`.slice(0, 200),
          });
          if (sent.ok) summary.emailsSent += 1;
          else summary.errors.push(`${ownerId} ${appt.id} email failed: ${sent.error || 'unknown'}`);
        }
      } else if (due.emails.length) {
        summary.errors.push(`${ownerId} ${appt.id}: daily email limit reached`);
      }

      if (due.phones.length && !(await reserveSendQuota(ownerId, 'sms', due.phones.length))) {
        for (const phone of due.phones) {
          const sms = await sendSmsNotification(phone, messages.smsText, { waitForStatus: true });
          if (sms.ok) summary.textsSent += 1;
          else summary.errors.push(`${ownerId} ${appt.id} text to ${maskPhone(phone)} failed: ${sms.error || 'unknown'}`);
        }
      } else if (due.phones.length) {
        summary.errors.push(`${ownerId} ${appt.id}: daily text limit reached`);
      }
    }
  }

  if (summary.due || summary.errors.length) {
    console.log('[client-appointment-reminders]', JSON.stringify(summary));
  }
  return NextResponse.json(summary);
}
