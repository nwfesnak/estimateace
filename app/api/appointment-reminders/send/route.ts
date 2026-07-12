import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import {
  buildContractorReminderMessage,
  getTodayDateKey,
  getTomorrowsAppointments,
  settingsDocId,
  type StoredAppointment,
} from '@/lib/appointment-reminders';
import { sendEmailNotification, sendSmsNotification } from '@/lib/notifications';

async function verifyUser(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return { user: null, supabase: null, error: 'Missing or invalid Authorization header' };
  }

  const token = authHeader.split(' ')[1];
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    return { user: null, supabase: null, error: 'Supabase not configured' };
  }

  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) {
    return { user: null, supabase: null, error: 'Unauthorized' };
  }

  return { user, supabase, error: null };
}

export async function POST(request: NextRequest) {
  try {
    const { user, supabase, error: authError } = await verifyUser(request);
    if (authError || !user || !supabase) {
      return NextResponse.json({ error: authError || 'Unauthorized' }, { status: 401 });
    }

    const { data, error } = await supabase
      .from('estimates')
      .select('profile')
      .eq('id', settingsDocId(user.id))
      .maybeSingle();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const body = await request.json().catch(() => ({}));
    const forceTest = body?.force === true;

    const profile = data?.profile || {};
    if (!profile.appointmentReminderEnabled && !forceTest) {
      return NextResponse.json({ skipped: true, reason: 'Appointment reminders are off.' });
    }

    const todayKey = getTodayDateKey();
    if (!forceTest && profile._lastReminderSentDate === todayKey) {
      return NextResponse.json({ skipped: true, reason: 'Reminder already sent today.' });
    }

    const appointments = (profile._appointments || []) as StoredAppointment[];
    let tomorrowAppointments = getTomorrowsAppointments(appointments);
    if (tomorrowAppointments.length === 0 && forceTest) {
      tomorrowAppointments = appointments
        .filter(appt => new Date(appt.datetime).getTime() > Date.now())
        .sort((a, b) => new Date(a.datetime).getTime() - new Date(b.datetime).getTime())
        .slice(0, 5);
      if (tomorrowAppointments.length === 0) {
        return NextResponse.json({ skipped: true, reason: 'No upcoming appointments to test with.' });
      }
    } else if (tomorrowAppointments.length === 0) {
      return NextResponse.json({ skipped: true, reason: 'No appointments tomorrow.' });
    }

    const contractorEmail = (profile.email || '').trim();
    const contractorPhone = (profile.phone || '').trim();
    const companyName = profile.company || 'EstimateAce';
    const { subject, emailText, smsText } = buildContractorReminderMessage(
      tomorrowAppointments,
      companyName
    );

    const result = {
      emailsSent: [] as string[],
      smsSent: [] as string[],
      errors: [] as string[],
    };

    if (!contractorEmail || !contractorEmail.includes('@')) {
      result.errors.push('Add your company email on the Profile page to receive reminders.');
    } else {
      const emailResult = await sendEmailNotification(contractorEmail, subject, emailText);
      if (emailResult.ok) result.emailsSent.push(contractorEmail);
      else if (emailResult.error) result.errors.push(emailResult.error);
    }

    if (!contractorPhone) {
      result.errors.push('Add your company phone on the Profile page to receive text reminders.');
    } else {
      const smsResult = await sendSmsNotification(contractorPhone, smsText);
      if (smsResult.ok) result.smsSent.push(contractorPhone);
      else if (smsResult.error) result.errors.push(smsResult.error);
    }

    const notified = result.emailsSent.length > 0 || result.smsSent.length > 0;
    if (notified && !forceTest) {
      await supabase.from('estimates').upsert({
        id: settingsDocId(user.id),
        user_id: user.id,
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

    return NextResponse.json({
      ...result,
      notified,
      appointmentCount: tomorrowAppointments.length,
      testMode: forceTest,
    });
  } catch (err: unknown) {
    console.error('Appointment reminder send error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to send appointment reminder' },
      { status: 500 }
    );
  }
}