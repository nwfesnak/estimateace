import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

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
  return { user, error: null };
}

function formatPhoneE164(phone: string): string | null {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length >= 11) return `+${digits}`;
  return null;
}

function buildLocation(address?: string, city?: string, state?: string, zipCode?: string) {
  const parts = [address, city, state, zipCode].filter(Boolean);
  return parts.length ? parts.join(', ') : '';
}

export async function POST(request: NextRequest) {
  try {
    const { user, error: authError } = await verifyUser(request);
    if (authError || !user) {
      return NextResponse.json({ error: authError || 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const {
      jobName,
      invoiceNumber,
      address,
      city,
      state,
      zipCode,
      appointmentDateTime,
      emails = [],
      phones = [],
      companyName = 'EstimateAce',
      companyPhone = '',
    } = body;

    if (!appointmentDateTime) {
      return NextResponse.json({ error: 'appointmentDateTime is required' }, { status: 400 });
    }

    const clientEmails = (Array.isArray(emails) ? emails : [])
      .map((e: string) => e?.trim())
      .filter((e: string) => e && e.includes('@'));
    const clientPhones = (Array.isArray(phones) ? phones : [])
      .map((p: string) => p?.trim())
      .filter(Boolean);

    const appointmentDate = new Date(appointmentDateTime);
    const formattedDate = appointmentDate.toLocaleString('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
    const location = buildLocation(address, city, state, zipCode);
    const reference = invoiceNumber || 'N/A';
    const clientName = jobName || 'Valued Client';

    const emailSubject = `Appointment Scheduled - ${companyName}`;
    const emailText = [
      `Hello ${clientName},`,
      '',
      `Your appointment with ${companyName} has been scheduled.`,
      '',
      `Date & Time: ${formattedDate}`,
      `Reference: ${reference}`,
      location ? `Location: ${location}` : '',
      companyPhone ? `Contact: ${companyPhone}` : '',
      '',
      'If you need to reschedule, please contact us as soon as possible.',
      '',
      `— ${companyName}`,
    ].filter(Boolean).join('\n');

    const smsText = `${companyName}: Appointment scheduled for ${clientName} on ${formattedDate}${location ? ` at ${location}` : ''}. Ref ${reference}.${companyPhone ? ` Call ${companyPhone} to reschedule.` : ''}`;

    const result = {
      emailsSent: [] as string[],
      smsSent: [] as string[],
      errors: [] as string[],
    };

    const resendKey = process.env.RESEND_API_KEY;
    const fromEmail = process.env.NOTIFICATION_FROM_EMAIL || 'EstimateAce <onboarding@resend.dev>';

    if (clientEmails.length === 0) {
      result.errors.push('No client email addresses on file for this estimate.');
    } else if (!resendKey) {
      result.errors.push('Email service not configured. Add RESEND_API_KEY to .env.local.');
    } else {
      for (const email of clientEmails) {
        try {
          const response = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${resendKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              from: fromEmail,
              to: [email],
              subject: emailSubject,
              text: emailText,
            }),
          });

          if (response.ok) {
            result.emailsSent.push(email);
          } else {
            const errBody = await response.text();
            result.errors.push(`Email to ${email} failed: ${errBody}`);
          }
        } catch (err: unknown) {
          result.errors.push(`Email to ${email} failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
        }
      }
    }

    const twilioSid = process.env.TWILIO_ACCOUNT_SID;
    const twilioToken = process.env.TWILIO_AUTH_TOKEN;
    const twilioFrom = process.env.TWILIO_PHONE_NUMBER;

    if (clientPhones.length === 0) {
      result.errors.push('No client phone numbers on file for this estimate.');
    } else if (!twilioSid || !twilioToken || !twilioFrom) {
      result.errors.push('SMS service not configured. Add TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER to .env.local.');
    } else {
      const twilioAuth = Buffer.from(`${twilioSid}:${twilioToken}`).toString('base64');

      for (const phone of clientPhones) {
        const to = formatPhoneE164(phone);
        if (!to) {
          result.errors.push(`Invalid phone number: ${phone}`);
          continue;
        }

        try {
          const params = new URLSearchParams({
            To: to,
            From: twilioFrom,
            Body: smsText.slice(0, 1600),
          });

          const response = await fetch(
            `https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`,
            {
              method: 'POST',
              headers: {
                Authorization: `Basic ${twilioAuth}`,
                'Content-Type': 'application/x-www-form-urlencoded',
              },
              body: params.toString(),
            }
          );

          if (response.ok) {
            result.smsSent.push(phone);
          } else {
            const errBody = await response.text();
            result.errors.push(`Text to ${phone} failed: ${errBody}`);
          }
        } catch (err: unknown) {
          result.errors.push(`Text to ${phone} failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
        }
      }
    }

    const notified = result.emailsSent.length > 0 || result.smsSent.length > 0;
    return NextResponse.json({ ...result, notified });
  } catch (err: unknown) {
    console.error('Appointment notify error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to send notifications' },
      { status: 500 }
    );
  }
}