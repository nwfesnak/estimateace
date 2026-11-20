/**
 * Customer appointment schedule / reschedule notifications.
 *
 * Shared by the calendar confirm dialog and /api/appointment-notify so the
 * preview the contractor sees matches what is actually sent.
 */

import { formatPhoneE164 } from '@/lib/notifications';

export type AppointmentNotifyKind = 'scheduled' | 'updated';

export type AppointmentNotifyInput = {
  jobName?: string;
  invoiceNumber?: string;
  customerName?: string;
  address?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  appointmentDateTime: string;
  timeZone?: string;
  companyName?: string;
  companyPhone?: string;
  kind?: AppointmentNotifyKind;
  /** Public confirm-appointment URL included in SMS and email when present. */
  confirmUrl?: string;
};

export type AppointmentNotifyMessages = {
  kind: AppointmentNotifyKind;
  timeZone: string;
  formattedWhen: string;
  customerName: string;
  jobLabel: string;
  location: string;
  reference: string;
  companyName: string;
  subject: string;
  emailText: string;
  emailHtml: string;
  smsText: string;
};

export type AppointmentNotifyStatus = {
  at: string;
  kind: AppointmentNotifyKind;
  status: 'notified' | 'scheduled_only' | 'partial';
  appointmentId?: string;
  emails?: string[];
  phones?: string[];
  emailedAt?: string;
  textedAt?: string;
  errors?: string[];
  /** SHA-256 hex of the confirm token. Server-only; strip before sending to the browser. */
  confirmTokenHash?: string;
  confirmExpiresAt?: string;
  confirmedAt?: string | null;
  ownerNotifiedAt?: string;
  timeZone?: string;
  formattedWhen?: string;
  companyName?: string;
  jobName?: string;
  location?: string;
  customerName?: string;
};

export function ownerTimeZone(fallback = 'America/New_York'): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz && typeof tz === 'string') return tz;
  } catch {
    /* ignore */
  }
  return fallback;
}

export function isValidIanaTimeZone(timeZone?: string | null): boolean {
  const tz = String(timeZone || '').trim();
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function resolveNotifyTimeZone(timeZone?: string | null): string {
  return isValidIanaTimeZone(timeZone) ? String(timeZone).trim() : 'America/New_York';
}

/** Readable date & time in the owner's timezone, with a short zone name (e.g. EST). */
export function formatAppointmentWhen(iso: string, timeZone?: string): string {
  const tz = resolveNotifyTimeZone(timeZone);
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const datePart = d.toLocaleDateString('en-US', {
    timeZone: tz,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
  const timePart = d.toLocaleTimeString('en-US', {
    timeZone: tz,
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
  return `${datePart} at ${timePart}`;
}

export function buildLocation(
  address?: string,
  city?: string,
  state?: string,
  zipCode?: string
): string {
  const street = String(address || '').trim();
  const cityPart = String(city || '').trim();
  const stateZip = [String(state || '').trim(), String(zipCode || '').trim()].filter(Boolean).join(' ');
  return [street, cityPart, stateZip].filter(Boolean).join(', ');
}

/**
 * Customer greeting name. Estimates typically don't store a separate person name,
 * so we only use an explicit client/customer name field — never the job title.
 */
export function customerNameFromEstimate(est: Record<string, unknown> | null | undefined): string {
  if (!est || typeof est !== 'object') return '';
  const profile =
    est.profile && typeof est.profile === 'object' ? (est.profile as Record<string, unknown>) : {};
  for (const value of [est.clientName, est.customerName, est.contactName, profile.clientName, profile.customerName]) {
    const name = String(value || '').trim();
    if (name) return name.slice(0, 80);
  }
  return '';
}

export function collectEstimateEmails(est: Record<string, unknown> | null | undefined): string[] {
  const raw = (est?.emails as unknown) || [];
  const list = Array.isArray(raw) ? raw : [raw];
  const out: string[] = [];
  for (const item of list) {
    const email = String(item || '').trim();
    if (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && !out.includes(email)) {
      out.push(email);
    }
  }
  return out;
}

export function collectEstimatePhones(est: Record<string, unknown> | null | undefined): string[] {
  const raw = (est?.phones as unknown) || [];
  const list = Array.isArray(raw) ? raw : [raw];
  const out: string[] = [];
  for (const item of list) {
    const phone = String(item || '').trim();
    if (!phone) continue;
    const e164 = formatPhoneE164(phone);
    const key = e164 || phone;
    if (!out.some((p) => (formatPhoneE164(p) || p) === key)) out.push(phone);
  }
  return out;
}

export function isTwilioConfigured(env: NodeJS.Dict<string> = process.env): boolean {
  const sid = String(env.TWILIO_ACCOUNT_SID || '').trim();
  const token = String(env.TWILIO_AUTH_TOKEN || '').trim();
  const from = String(env.TWILIO_PHONE_NUMBER || '').trim();
  const messaging = String(env.TWILIO_MESSAGING_SERVICE_SID || '').trim();
  return !!(sid && token && (from || messaging));
}

export function isResendConfigured(env: NodeJS.Dict<string> = process.env): boolean {
  return !!String(env.RESEND_API_KEY || '').trim();
}

function escapeHtml(s: string): string {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function buildAppointmentNotifyMessages(input: AppointmentNotifyInput): AppointmentNotifyMessages {
  const kind: AppointmentNotifyKind = input.kind === 'updated' ? 'updated' : 'scheduled';
  const timeZone = resolveNotifyTimeZone(input.timeZone);
  const formattedWhen = formatAppointmentWhen(input.appointmentDateTime, timeZone);
  const companyName = String(input.companyName || '').trim() || 'EstimateAce';
  const companyPhone = String(input.companyPhone || '').trim();
  const jobName = String(input.jobName || '').trim();
  const reference = String(input.invoiceNumber || '').trim() || 'N/A';
  const location = buildLocation(input.address, input.city, input.state, input.zipCode);
  const customerName = String(input.customerName || '').trim();
  const confirmUrl = String(input.confirmUrl || '').trim();
  const jobLabel = jobName ? (reference && reference !== 'N/A' ? `${jobName} (${reference})` : jobName) : reference;
  const greeting = customerName ? `Hello ${customerName},` : 'Hello,';
  const jobLine = jobName ? `Job: ${jobName}` : '';
  const whenLabel = kind === 'updated' ? 'Date & time (updated)' : 'Date & time';

  const subject =
    kind === 'updated'
      ? `Your appointment with ${companyName} has been updated`
      : `Your appointment with ${companyName} is scheduled`;

  const intro =
    kind === 'updated'
      ? `${companyName} has updated the date and time for your appointment.`
      : `${companyName} has scheduled your appointment.`;

  const emailLines = [
    greeting,
    '',
    intro,
    '',
    jobLine,
    `${whenLabel}: ${formattedWhen}`,
    location ? `Location: ${location}` : '',
    `Reference: ${reference}`,
    companyPhone ? `Questions? Call ${companyPhone}` : '',
    '',
    confirmUrl ? 'Please confirm that you can make this appointment:' : '',
    confirmUrl ? confirmUrl : '',
    '',
    'If you need to reschedule, please contact us as soon as possible.',
    '',
    `— ${companyName}`,
  ].filter((line, i, arr) => line !== '' || (arr[i - 1] !== '' && i !== 0));

  const emailText = emailLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();

  const emailHtml = `<!DOCTYPE html>
<html><body style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#0f172a;line-height:1.5;max-width:560px;margin:0 auto;padding:24px;">
  <div style="border-top:6px solid #10b981;border-radius:16px;padding:8px 0 0;">
    <p style="margin:0 0 4px;font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:#0f766e;font-weight:700;">${escapeHtml(companyName)}</p>
    <h1 style="font-size:22px;margin:0 0 16px;">${kind === 'updated' ? 'Your appointment has been updated' : 'Your appointment is scheduled'}</h1>
    <p style="margin:0 0 16px;">${escapeHtml(greeting)}</p>
    <p style="margin:0 0 16px;">${escapeHtml(intro)}</p>
    <div style="background:#f0fdfa;border:1px solid #99f6e4;border-radius:16px;padding:16px 18px;margin:0 0 20px;">
      ${jobName ? `<p style="margin:0 0 8px;"><strong>Job:</strong> ${escapeHtml(jobName)}</p>` : ''}
      <p style="margin:0 0 8px;"><strong>${escapeHtml(whenLabel)}:</strong> ${escapeHtml(formattedWhen)}</p>
      ${location ? `<p style="margin:0 0 8px;"><strong>Location:</strong> ${escapeHtml(location)}</p>` : ''}
      <p style="margin:0;"><strong>Reference:</strong> ${escapeHtml(reference)}</p>
    </div>
    ${companyPhone ? `<p style="margin:0 0 8px;">Questions? Call ${escapeHtml(companyPhone)}</p>` : ''}
    ${
      confirmUrl
        ? `<p style="margin:20px 0 8px;"><a href="${escapeHtml(confirmUrl)}" style="display:inline-block;background:#10b981;color:#ffffff;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:10px;">Confirm appointment</a></p>
    <p style="margin:0 0 16px;color:#334155;">Please confirm that you can make this appointment, or contact us if you need to reschedule.</p>`
        : `<p style="margin:0 0 24px;color:#334155;">If you need to reschedule, please contact us as soon as possible.</p>`
    }
    <p style="margin:0;color:#475569;">— ${escapeHtml(companyName)}</p>
  </div>
</body></html>`;

  const jobSms = jobName ? ` (${jobName})` : '';
  const locSms = location ? ` at ${location}` : '';
  const callSms = companyPhone
    ? kind === 'updated'
      ? ` Call ${companyPhone} with questions.`
      : ` Call ${companyPhone} to reschedule.`
    : '';
  const confirmSms = confirmUrl ? ` Confirm: ${confirmUrl}.` : '';
  const verb =
    kind === 'updated' ? `has been updated to ${formattedWhen}` : `is scheduled for ${formattedWhen}`;
  const smsText =
    `${companyName}: Your appointment${jobSms} ${verb}${locSms}. Ref ${reference}.${confirmSms}${callSms} Reply STOP to opt out.`.slice(
      0,
      1600
    );

  return {
    kind,
    timeZone,
    formattedWhen,
    customerName,
    jobLabel,
    location,
    reference,
    companyName,
    subject,
    emailText,
    emailHtml,
    smsText,
  };
}
