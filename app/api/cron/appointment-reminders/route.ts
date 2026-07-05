import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import {
  buildContractorReminderMessage,
  getTodayDateKey,
  getTomorrowsAppointments,
  type StoredAppointment,
} from '@/lib/appointment-reminders';
import { sendEmailNotification, sendSmsNotification } from '@/lib/notifications';

export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get('authorization');
  const isVercelCron = request.headers.get('x-vercel-cron') === '1';

  if (cronSecret && authHeader !== `Bearer ${cronSecret}` && !isVercelCron) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    return NextResponse.json(
      { error: 'Supabase service role not configured for cron reminders.' },
      { status: 500 }
    );
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey);
  const todayKey = getTodayDateKey();

  const { data: settingsRows, error } = await supabase
    .from('estimates')
    .select('user_id, profile')
    .eq('jobName', '__settings__');

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const summary = {
    processed: 0,
    sent: 0,
    skipped: 0,
    errors: [] as string[],
  };

  for (const row of settingsRows || []) {
    const profile = row.profile || {};
    if (!profile.appointmentReminderEnabled) {
      summary.skipped += 1;
      continue;
    }

    if (profile._lastReminderSentDate === todayKey) {
      summary.skipped += 1;
      continue;
    }

    const appointments = (profile._appointments || []) as StoredAppointment[];
    const tomorrowAppointments = getTomorrowsAppointments(appointments);
    if (tomorrowAppointments.length === 0) {
      summary.skipped += 1;
      continue;
    }

    summary.processed += 1;

    const contractorEmail = (profile.email || '').trim();
    const contractorPhone = (profile.phone || '').trim();
    const companyName = profile.company || 'EstimateAce';
    const { subject, emailText, smsText } = buildContractorReminderMessage(
      tomorrowAppointments,
      companyName
    );

    let notified = false;

    if (contractorEmail && contractorEmail.includes('@')) {
      const emailResult = await sendEmailNotification(contractorEmail, subject, emailText);
      if (emailResult.ok) notified = true;
      else if (emailResult.error) summary.errors.push(`${row.user_id} email: ${emailResult.error}`);
    } else {
      summary.errors.push(`${row.user_id}: missing company email in profile settings`);
    }

    if (contractorPhone) {
      const smsResult = await sendSmsNotification(contractorPhone, smsText);
      if (smsResult.ok) notified = true;
      else if (smsResult.error) summary.errors.push(`${row.user_id} sms: ${smsResult.error}`);
    } else {
      summary.errors.push(`${row.user_id}: missing company phone in profile settings`);
    }

    if (notified) {
      summary.sent += 1;
      await supabase.from('estimates').upsert({
        id: `SETTINGS-${row.user_id}`,
        user_id: row.user_id,
        jobName: '__settings__',
        documentType: 'settings',
        items: [],
        profile: {
          ...profile,
          _lastReminderSentDate: todayKey,
        },
        updated_at: new Date().toISOString(),
      });
    }
  }

  return NextResponse.json(summary);
}