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
    const optInConfirm = body?.optInConfirm === true;

    const profile = data?.profile || {};

    // Explicit SMS opt-in confirmation text (from Profile toggle)
    if (optInConfirm) {
      const contractorPhone = String(profile.phone || '').trim();
      const companyName = profile.company || 'EstimateAce';
      if (!contractorPhone) {
        return NextResponse.json(
          { error: 'Add your company phone on the Profile page first.' },
          { status: 400 }
        );
      }
      if (!profile.smsOptIn) {
        return NextResponse.json(
          { error: 'Turn on “Opt in to text messaging” on Profile first.' },
          { status: 400 }
        );
      }
      const smsText =
        `EstimateAce: You're opted in to transactional texts for ${companyName} (reminders, estimate/invoice notices). Msg&data rates may apply. Reply STOP to opt out, HELP for help.`.slice(
          0,
          1600
        );
      const smsResult = await sendSmsNotification(contractorPhone, smsText, {
        waitForStatus: true,
      });
      return NextResponse.json({
        notified: !!smsResult.ok,
        smsSent: smsResult.ok ? [contractorPhone] : [],
        emailsSent: [],
        errors: smsResult.ok
          ? smsResult.status && smsResult.status !== 'delivered'
            ? [
                `SMS accepted (status: ${smsResult.status}). If it does not arrive, finish Twilio number verification / A2P registration.`,
              ]
            : []
          : [smsResult.error || 'SMS failed'],
        optInConfirm: true,
        testMode: true,
      });
    }

    if (!profile.appointmentReminderEnabled && !forceTest) {
      return NextResponse.json({ skipped: true, reason: 'Appointment reminders are off.' });
    }

    const todayKey = getTodayDateKey();
    if (!forceTest && profile._lastReminderSentDate === todayKey) {
      return NextResponse.json({ skipped: true, reason: 'Reminder already sent today.' });
    }

    const appointments = (profile._appointments || []) as StoredAppointment[];
    let tomorrowAppointments = getTomorrowsAppointments(appointments);
    let usedSampleAppointment = false;
    if (tomorrowAppointments.length === 0 && forceTest) {
      tomorrowAppointments = appointments
        .filter(appt => new Date(appt.datetime).getTime() > Date.now())
        .sort((a, b) => new Date(a.datetime).getTime() - new Date(b.datetime).getTime())
        .slice(0, 5);
      // Allow Twilio/email test with no calendar data — send a sample appointment
      if (tomorrowAppointments.length === 0) {
        const sampleWhen = new Date();
        sampleWhen.setDate(sampleWhen.getDate() + 1);
        sampleWhen.setHours(10, 0, 0, 0);
        tomorrowAppointments = [
          {
            id: 'TEST-SAMPLE',
            estimateId: 'TEST',
            jobName: 'Sample client (Twilio test)',
            invoiceNumber: 'TEST-SMS',
            datetime: sampleWhen.toISOString(),
          },
        ];
        usedSampleAppointment = true;
      }
    } else if (tomorrowAppointments.length === 0) {
      return NextResponse.json({ skipped: true, reason: 'No appointments tomorrow.' });
    }

    const contractorEmail = (profile.email || '').trim();
    const contractorPhone = (profile.phone || '').trim();
    const companyName = profile.company || 'EstimateAce';
    const built = buildContractorReminderMessage(tomorrowAppointments, companyName);
    const subject = usedSampleAppointment
      ? `EstimateAce SMS test — ${companyName}`
      : built.subject;
    const emailText = usedSampleAppointment
      ? [
          `This is a test from EstimateAce (no real appointments on your calendar).`,
          '',
          built.emailText,
          '',
          'If you received this email, outbound email is working.',
        ].join('\n')
      : built.emailText;
    const smsText = usedSampleAppointment
      ? `EstimateAce TEST: Twilio SMS is working for ${companyName || 'your account'}. Sample: 1 appointment tomorrow (not a real booking).`.slice(
          0,
          1600
        )
      : built.smsText;

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
    } else if (!profile.smsOptIn) {
      result.errors.push(
        'Opt in to text messaging on Profile (below Appointment Reminders) to receive SMS.'
      );
    } else {
      // On manual "Test Reminder Now", wait briefly for delivery status so we
      // don't report success when Twilio later marks undelivered (e.g. 30032).
      const smsResult = await sendSmsNotification(contractorPhone, smsText, {
        waitForStatus: forceTest,
      });
      if (smsResult.ok) {
        result.smsSent.push(contractorPhone);
        if (forceTest && smsResult.status && smsResult.status !== 'delivered') {
          result.errors.push(
            `SMS accepted by Twilio (status: ${smsResult.status}). If it does not arrive, check Toll-Free Verification / A2P 10DLC registration in Twilio Console.`
          );
        }
      } else if (smsResult.error) {
        result.errors.push(smsResult.error);
      }
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
      sampleAppointment: usedSampleAppointment,
    });
  } catch (err: unknown) {
    console.error('Appointment reminder send error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to send appointment reminder' },
      { status: 500 }
    );
  }
}