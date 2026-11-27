import { NextRequest, NextResponse } from 'next/server';
import { TWO_STEP_REQUIRED, twoStepPending } from '@/lib/supabase/auth-user';
import { createClient } from '@supabase/supabase-js';
import { enforceAppAccess, workspaceOwnerId } from '@/lib/billing-access';
import { requireWorkspaceOwner } from '@/lib/workspace';
import { guardUserSends } from '@/lib/send-guard';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { isUsPhoneE164 } from '@/lib/rate-limit';
import { formatPhoneE164, sendEmailNotification, sendSmsNotification } from '@/lib/notifications';
import { getSmsOptIn } from '@/lib/sms-opt-in-store';
import {
  buildAppointmentNotifyMessages,
  collectEstimateEmails,
  collectEstimatePhones,
  customerNameFromEstimate,
  isResendConfigured,
  isTwilioConfigured,
  type AppointmentNotifyKind,
  type AppointmentNotifyStatus,
} from '@/lib/appointment-notify';
import {
  appointmentConfirmUrl,
  issueAppointmentConfirm,
  publicNotifyStatus,
} from '@/lib/appointment-confirm';

async function verifyUser(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return { user: null, error: 'Missing or invalid Authorization header' };
  }

  const token = authHeader.split(' ')[1];
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    return { user: null, error: 'Supabase not configured' };
  }

  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) {
    return { user: null, error: 'Unauthorized' };
  }
  if (twoStepPending(request, user)) return { user: null, error: TWO_STEP_REQUIRED };
  return { user, error: null };
}

async function smsChannelStatus(phones: string[]) {
  const twilioConfigured = isTwilioConfigured();
  const details: Array<{ phone: string; eligible: boolean; reason?: string }> = [];
  for (const phone of phones) {
    const e164 = formatPhoneE164(phone);
    if (!e164) {
      details.push({ phone, eligible: false, reason: 'Invalid phone number.' });
      continue;
    }
    if (!isUsPhoneE164(e164)) {
      details.push({ phone, eligible: false, reason: 'Text messages can only be sent to US numbers.' });
      continue;
    }
    if (!twilioConfigured) {
      details.push({ phone, eligible: false, reason: 'Text messaging is not available right now.' });
      continue;
    }
    try {
      const consent = await getSmsOptIn(e164);
      if (consent?.optedOut) {
        details.push({ phone, eligible: false, reason: 'This number has opted out of SMS (STOP).' });
        continue;
      }
    } catch {
      // Missing or unread consent store: allow transactional send (same as sendSmsNotification).
    }
    details.push({ phone, eligible: true });
  }
  return {
    twilioConfigured,
    details,
    eligiblePhones: details.filter((d) => d.eligible).map((d) => d.phone),
    optedOutPhones: details
      .filter((d) => (d.reason || '').includes('opted out'))
      .map((d) => d.phone),
  };
}

async function recordNotifyOnEstimate(
  ownerId: string,
  estimateId: string | undefined,
  status: AppointmentNotifyStatus
) {
  const id = String(estimateId || '').trim();
  if (!id || id.startsWith('SETTINGS-') || id.startsWith('REC-') || id.startsWith('RECEPTIONIST-') || id.startsWith('PLATFORM-')) {
    return;
  }
  const admin = getSupabaseAdmin();
  if (!admin) return;
  try {
    const { data: row } = await admin
      .from('estimates')
      .select('id, profile')
      .eq('id', id)
      .eq('user_id', ownerId)
      .maybeSingle();
    if (!row?.id) return;
    const prev = row.profile && typeof row.profile === 'object' ? (row.profile as Record<string, unknown>) : {};
    const { error } = await admin
      .from('estimates')
      .update({
        profile: { ...prev, _appointmentNotify: status },
        updated_at: new Date().toISOString(),
      })
      .eq('id', row.id)
      .eq('user_id', ownerId);
    if (error) console.warn('appointment-notify record on estimate:', error.message);
  } catch (err) {
    console.warn('appointment-notify record on estimate failed:', err);
  }
}

export async function POST(request: NextRequest) {
  try {
    const { user, error: authError } = await verifyUser(request);
    if (authError || !user) {
      return NextResponse.json({ error: authError || 'Unauthorized' }, { status: 401 });
    }
    const paywall = await enforceAppAccess(user.id);
    if (paywall) return paywall;
    const ws = await requireWorkspaceOwner(user.id, undefined, { requireTab: 'calendar' });
    if (ws.denied) return ws.denied;
    const ownerId = await workspaceOwnerId(user.id);

    const body = await request.json();
    const preview = body.preview === true;
    const scheduleOnly = body.scheduleOnly === true;
    const sendEmail = body.sendEmail === true;
    const sendSms = body.sendSms === true;
    const kind: AppointmentNotifyKind = body.isUpdate === true || body.kind === 'updated' ? 'updated' : 'scheduled';
    const estimateId = typeof body.estimateId === 'string' ? body.estimateId : '';
    const appointmentId = typeof body.appointmentId === 'string' ? body.appointmentId : '';

    const emails = collectEstimateEmails({ emails: body.emails });
    const phones = collectEstimatePhones({ phones: body.phones });
    const customerName =
      String(body.customerName || '').trim() ||
      customerNameFromEstimate(body);

    if (!body.appointmentDateTime) {
      return NextResponse.json({ error: 'appointmentDateTime is required' }, { status: 400 });
    }
    if (Number.isNaN(new Date(body.appointmentDateTime).getTime())) {
      return NextResponse.json({ error: 'appointmentDateTime is invalid' }, { status: 400 });
    }

    if (emails.length > 10 || phones.length > 5) {
      return NextResponse.json(
        { error: 'Too many recipients. Send to at most 10 emails and 5 phone numbers at a time.' },
        { status: 400 }
      );
    }

    const confirmPreviewUrl = appointmentConfirmUrl();
    const messageInput = {
      jobName: body.jobName,
      invoiceNumber: body.invoiceNumber,
      customerName,
      address: body.address,
      city: body.city,
      state: body.state,
      zipCode: body.zipCode,
      appointmentDateTime: body.appointmentDateTime,
      timeZone: body.timeZone,
      companyName: body.companyName || 'EstimateAce',
      companyPhone: body.companyPhone || '',
      kind,
      confirmUrl: confirmPreviewUrl,
    };
    let messages = buildAppointmentNotifyMessages(messageInput);

    const sms = await smsChannelStatus(phones);
    const resendConfigured = isResendConfigured();
    const canEmail = emails.length > 0 && resendConfigured;
    const canSms = sms.eligiblePhones.length > 0;

    if (preview || (!scheduleOnly && !sendEmail && !sendSms)) {
      return NextResponse.json({
        preview: true,
        kind: messages.kind,
        formattedWhen: messages.formattedWhen,
        timeZone: messages.timeZone,
        customerName: messages.customerName,
        jobLabel: messages.jobLabel,
        location: messages.location,
        reference: messages.reference,
        companyName: messages.companyName,
        emails,
        phones,
        canEmail,
        canSms,
        resendConfigured,
        twilioConfigured: sms.twilioConfigured,
        phoneDetails: sms.details,
        optedOutPhones: sms.optedOutPhones,
        subject: messages.subject,
        emailText: messages.emailText,
        smsText: messages.smsText,
      });
    }

    const now = new Date().toISOString();

    if (scheduleOnly) {
      const status: AppointmentNotifyStatus = {
        at: now,
        kind,
        status: 'scheduled_only',
        appointmentId,
        timeZone: messages.timeZone,
        formattedWhen: messages.formattedWhen,
        confirmedAt: null,
      };
      await recordNotifyOnEstimate(ownerId, estimateId, status);
      return NextResponse.json({
        notified: false,
        scheduleOnly: true,
        notify: publicNotifyStatus(status),
      });
    }

    {
      const denied = await guardUserSends(user, ownerId, {
        email: sendEmail ? emails.length : 0,
        sms: sendSms ? sms.eligiblePhones.length : 0,
      });
      if (denied) return denied;
    }

    const issued =
      estimateId && !estimateId.startsWith('SETTINGS-') && !estimateId.startsWith('REC-')
        ? issueAppointmentConfirm(estimateId, String(body.appointmentDateTime))
        : issueAppointmentConfirm(appointmentId || messages.reference || 'appt', String(body.appointmentDateTime));
    const confirmUrl = appointmentConfirmUrl(issued.token);
    messages = buildAppointmentNotifyMessages({ ...messageInput, confirmUrl });

    const result = {
      emailsSent: [] as string[],
      smsSent: [] as string[],
      errors: [] as string[],
    };

    if (sendEmail) {
      if (emails.length === 0) {
        result.errors.push('No customer email on file for this estimate.');
      } else if (!resendConfigured) {
        result.errors.push('Email service is not configured.');
      } else {
        const replyTo = String(body.companyEmail || '').trim();
        for (const email of emails) {
          const sent = await sendEmailNotification(email, messages.subject, messages.emailText, {
            html: messages.emailHtml,
            companyName: messages.companyName,
            replyTo: replyTo || undefined,
            idempotencyKey: `appt-notify:${ownerId}:${appointmentId || estimateId || messages.reference}:${kind}:email:${email}`.slice(
              0,
              200
            ),
          });
          if (sent.ok) result.emailsSent.push(email);
          else result.errors.push(`Email to ${email} failed: ${sent.error || 'Unknown error'}`);
        }
      }
    }

    if (sendSms) {
      if (phones.length === 0) {
        result.errors.push('No customer phone number on file for this estimate.');
      } else if (!sms.twilioConfigured) {
        result.errors.push('Text messaging is not available right now.');
      } else if (sms.eligiblePhones.length === 0) {
        result.errors.push(sms.details[0]?.reason || 'This number cannot be texted.');
      } else {
        for (const phone of sms.eligiblePhones) {
          // Twilio accepts (201) messages that the carrier later blocks (e.g. 30034
          // unregistered A2P 10DLC). Poll briefly so we don't report "texted" when it wasn't.
          const smsResult = await sendSmsNotification(phone, messages.smsText, { waitForStatus: true });
          if (smsResult.ok) result.smsSent.push(phone);
          else result.errors.push(`Text to ${phone} failed: ${smsResult.error || 'Unknown error'}`);
        }
        for (const skipped of sms.details.filter((d) => !d.eligible)) {
          result.errors.push(`Text to ${skipped.phone} skipped: ${skipped.reason}`);
        }
      }
    }

    const emailedAt = result.emailsSent.length ? now : undefined;
    const textedAt = result.smsSent.length ? now : undefined;
    const notified = result.emailsSent.length > 0 || result.smsSent.length > 0;
    const status: AppointmentNotifyStatus = {
      at: now,
      kind,
      status: notified && result.errors.length === 0 ? 'notified' : notified ? 'partial' : 'scheduled_only',
      appointmentId,
      emails: result.emailsSent,
      phones: result.smsSent,
      emailedAt,
      textedAt,
      errors: result.errors.length ? result.errors : undefined,
      timeZone: messages.timeZone,
      formattedWhen: messages.formattedWhen,
      companyName: messages.companyName,
      jobName: String(body.jobName || '').trim() || undefined,
      location: messages.location || undefined,
      customerName: messages.customerName || undefined,
      confirmedAt: null,
      ...(notified
        ? { confirmTokenHash: issued.hash, confirmExpiresAt: issued.expiresAt }
        : {}),
    };
    await recordNotifyOnEstimate(ownerId, estimateId, status);

    return NextResponse.json({
      ...result,
      notified,
      notify: publicNotifyStatus(status),
      formattedWhen: messages.formattedWhen,
    });
  } catch (err: unknown) {
    console.error('Appointment notify error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to send notifications' },
      { status: 500 }
    );
  }
}
