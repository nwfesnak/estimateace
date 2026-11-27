/**
 * Morning-of reminders to the CUSTOMER for a scheduled calendar appointment.
 *
 * Runs from /api/cron/client-appointment-reminders (Vercel Cron, hourly). Each run
 * sends only for appointments that are today in the company's local time zone and
 * only once the local clock has reached the reminder hour (default 7 AM), so a
 * contractor in Chicago and one in Los Angeles both get a local-morning reminder.
 *
 * Recipients are the ones the contractor chose when scheduling (stored on the
 * appointment's notify status). Schedule-only appointments get no reminder.
 */

import { formatAppointmentWhen, resolveNotifyTimeZone, type AppointmentNotifyStatus } from '@/lib/appointment-notify';

export const DEFAULT_CLIENT_REMINDER_HOUR = 7;

export type ReminderAppointment = {
  id: string;
  estimateId?: string;
  jobName?: string;
  invoiceNumber?: string;
  datetime: string;
  notify?: AppointmentNotifyStatus;
};

export type DueClientReminder = {
  appointment: ReminderAppointment;
  dateKey: string;
  timeZone: string;
  emails: string[];
  phones: string[];
};

export function localDateKey(date: Date, timeZone: string): string {
  return date.toLocaleDateString('en-CA', { timeZone: resolveNotifyTimeZone(timeZone) });
}

export function localHour(date: Date, timeZone: string): number {
  const h = Number(
    date.toLocaleString('en-US', { timeZone: resolveNotifyTimeZone(timeZone), hour: 'numeric', hour12: false })
  );
  // Some ICU builds render midnight as 24.
  return h === 24 ? 0 : h;
}

export function resolveReminderHour(raw: unknown): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 4 && n <= 11 ? n : DEFAULT_CLIENT_REMINDER_HOUR;
}

/** Company time zone: the one used when the customer was notified, else Profile, else Eastern. */
export function resolveReminderTimeZone(
  appointment: ReminderAppointment,
  profile: Record<string, unknown> | null | undefined
): string {
  return resolveNotifyTimeZone(
    String(appointment.notify?.timeZone || profile?.timeZone || profile?.timezone || '').trim() || undefined
  );
}

function uniqueStrings(list: unknown): string[] {
  const out: string[] = [];
  for (const v of Array.isArray(list) ? list : []) {
    const s = String(v || '').trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/**
 * Appointments whose customer reminder is due right now. Pure: caller does the
 * once-per-appointment-per-day claim before sending.
 */
export function selectDueClientReminders(
  appointments: ReminderAppointment[] | null | undefined,
  profile: Record<string, unknown> | null | undefined,
  now = new Date()
): DueClientReminder[] {
  if (profile && profile.clientMorningReminderEnabled === false) return [];
  const hour = resolveReminderHour(profile?.clientReminderHour);
  const due: DueClientReminder[] = [];
  for (const appt of Array.isArray(appointments) ? appointments : []) {
    if (!appt || !appt.id || !appt.datetime) continue;
    const when = new Date(appt.datetime);
    if (Number.isNaN(when.getTime())) continue;
    // Already started or past: a reminder would be noise.
    if (when.getTime() <= now.getTime()) continue;
    const notify = appt.notify;
    // Only remind customers the contractor actually notified at scheduling time.
    if (!notify || notify.status === 'scheduled_only') continue;
    if (notify.appointmentId && notify.appointmentId !== appt.id) continue;
    const timeZone = resolveReminderTimeZone(appt, profile);
    const dateKey = localDateKey(now, timeZone);
    if (localDateKey(when, timeZone) !== dateKey) continue;
    if (localHour(now, timeZone) < hour) continue;
    const emails = uniqueStrings(notify.emails);
    const phones = uniqueStrings(notify.phones);
    if (emails.length === 0 && phones.length === 0) continue;
    due.push({ appointment: appt, dateKey, timeZone, emails, phones });
  }
  return due.sort(
    (a, b) => new Date(a.appointment.datetime).getTime() - new Date(b.appointment.datetime).getTime()
  );
}

function escapeHtml(s: string): string {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function buildClientMorningReminderMessages(input: {
  appointmentDateTime: string;
  timeZone: string;
  companyName?: string;
  companyPhone?: string;
  jobName?: string;
  location?: string;
  customerName?: string;
  reference?: string;
}): { subject: string; emailText: string; emailHtml: string; smsText: string; timeLabel: string } {
  const tz = resolveNotifyTimeZone(input.timeZone);
  const when = new Date(input.appointmentDateTime);
  const timeLabel = when.toLocaleTimeString('en-US', {
    timeZone: tz,
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
  const formattedWhen = formatAppointmentWhen(input.appointmentDateTime, tz);
  const companyName = String(input.companyName || '').trim() || 'EstimateAce';
  const companyPhone = String(input.companyPhone || '').trim();
  const jobName = String(input.jobName || '').trim();
  const location = String(input.location || '').trim();
  const customerName = String(input.customerName || '').trim();
  const reference = String(input.reference || '').trim();
  const greeting = customerName ? `Hello ${customerName},` : 'Hello,';

  const subject = `Reminder: ${companyName} is scheduled today at ${timeLabel}`;
  const emailText = [
    greeting,
    '',
    `This is a reminder that ${companyName} is scheduled to see you today at ${timeLabel}.`,
    '',
    jobName ? `Job: ${jobName}` : '',
    `Date & time: ${formattedWhen}`,
    location ? `Location: ${location}` : '',
    reference ? `Reference: ${reference}` : '',
    companyPhone ? `Questions or need to reschedule? Call ${companyPhone}` : 'If you need to reschedule, please contact us as soon as possible.',
    '',
    `— ${companyName}`,
  ]
    .filter((line, i, arr) => line !== '' || (arr[i - 1] !== '' && i !== 0))
    .join('\n')
    .trim();

  const emailHtml = `<!DOCTYPE html>
<html><body style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#0f172a;line-height:1.5;max-width:560px;margin:0 auto;padding:24px;">
  <div style="border-top:6px solid #10b981;border-radius:16px;padding:8px 0 0;">
    <p style="margin:0 0 4px;font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:#0f766e;font-weight:700;">${escapeHtml(companyName)}</p>
    <h1 style="font-size:22px;margin:0 0 16px;">Your appointment is today at ${escapeHtml(timeLabel)}</h1>
    <p style="margin:0 0 16px;">${escapeHtml(greeting)}</p>
    <div style="background:#f0fdfa;border:1px solid #99f6e4;border-radius:16px;padding:16px 18px;margin:0 0 20px;">
      ${jobName ? `<p style="margin:0 0 8px;"><strong>Job:</strong> ${escapeHtml(jobName)}</p>` : ''}
      <p style="margin:0 0 8px;"><strong>Date &amp; time:</strong> ${escapeHtml(formattedWhen)}</p>
      ${location ? `<p style="margin:0 0 8px;"><strong>Location:</strong> ${escapeHtml(location)}</p>` : ''}
      ${reference ? `<p style="margin:0;"><strong>Reference:</strong> ${escapeHtml(reference)}</p>` : ''}
    </div>
    <p style="margin:0 0 24px;color:#334155;">${
      companyPhone
        ? `Questions or need to reschedule? Call ${escapeHtml(companyPhone)}.`
        : 'If you need to reschedule, please contact us as soon as possible.'
    }</p>
    <p style="margin:0;color:#475569;">— ${escapeHtml(companyName)}</p>
  </div>
</body></html>`;

  const smsText = `${companyName}: Reminder, your appointment${jobName ? ` (${jobName})` : ''} is today at ${timeLabel}${
    location ? ` at ${location}` : ''
  }.${companyPhone ? ` Call ${companyPhone} to reschedule.` : ''} Reply STOP to opt out.`.slice(0, 1600);

  return { subject, emailText, emailHtml, smsText, timeLabel };
}
