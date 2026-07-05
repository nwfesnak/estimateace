export const REMINDER_TIMEZONE = 'America/New_York';

export type StoredAppointment = {
  id: string;
  estimateId: string;
  jobName: string;
  invoiceNumber: string;
  datetime: string;
};

export function settingsDocId(userId: string) {
  return `SETTINGS-${userId}`;
}

export function getTomorrowDateKey(now = new Date(), timeZone = REMINDER_TIMEZONE): string {
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return tomorrow.toLocaleDateString('en-CA', { timeZone });
}

export function getTodayDateKey(now = new Date(), timeZone = REMINDER_TIMEZONE): string {
  return now.toLocaleDateString('en-CA', { timeZone });
}

export function isAppointmentTomorrow(
  datetime: string,
  now = new Date(),
  timeZone = REMINDER_TIMEZONE
): boolean {
  const apptDay = new Date(datetime).toLocaleDateString('en-CA', { timeZone });
  return apptDay === getTomorrowDateKey(now, timeZone);
}

export function getTomorrowsAppointments(
  appointments: StoredAppointment[],
  now = new Date(),
  timeZone = REMINDER_TIMEZONE
): StoredAppointment[] {
  return appointments
    .filter(appt => isAppointmentTomorrow(appt.datetime, now, timeZone))
    .sort((a, b) => new Date(a.datetime).getTime() - new Date(b.datetime).getTime());
}

export function formatAppointmentLine(appt: StoredAppointment, timeZone = REMINDER_TIMEZONE): string {
  const when = new Date(appt.datetime).toLocaleString('en-US', {
    timeZone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  const client = appt.jobName || 'Client';
  const ref = appt.invoiceNumber || appt.estimateId;
  return `• ${client} (${ref}) — ${when}`;
}

export function buildContractorReminderMessage(
  appointments: StoredAppointment[],
  companyName: string,
  timeZone = REMINDER_TIMEZONE
): { subject: string; emailText: string; smsText: string } {
  const tomorrowLabel = new Date();
  tomorrowLabel.setDate(tomorrowLabel.getDate() + 1);
  const dayLabel = tomorrowLabel.toLocaleDateString('en-US', {
    timeZone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });

  const lines = appointments.map(appt => formatAppointmentLine(appt, timeZone));
  const count = appointments.length;
  const subject = `Appointment Reminder — ${count} appointment${count === 1 ? '' : 's'} tomorrow`;

  const emailText = [
    `Good morning${companyName ? ` from ${companyName}` : ''},`,
    '',
    `You have ${count} appointment${count === 1 ? '' : 's'} scheduled for tomorrow (${dayLabel}):`,
    '',
    ...lines,
    '',
    '— EstimateAce Appointment Reminder',
  ].join('\n');

  const smsText = `EstimateAce: ${count} appointment${count === 1 ? '' : 's'} tomorrow (${dayLabel}). ${lines.join(' ')}`.slice(0, 1600);

  return { subject, emailText, smsText };
}