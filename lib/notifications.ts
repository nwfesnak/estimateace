export function formatPhoneE164(phone: string): string | null {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length >= 11) return `+${digits}`;
  return null;
}

export type NotificationResult = {
  emailsSent: string[];
  smsSent: string[];
  errors: string[];
};

export async function sendEmailNotification(
  to: string,
  subject: string,
  text: string,
  options?: { html?: string; replyTo?: string }
): Promise<{ ok: boolean; error?: string; id?: string }> {
  const resendKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.NOTIFICATION_FROM_EMAIL || 'EstimateAce <onboarding@resend.dev>';

  if (!resendKey) {
    return { ok: false, error: 'Email service not configured. Add RESEND_API_KEY to Vercel (and redeploy).' };
  }

  const trimmedTo = String(to || '').trim();
  if (!trimmedTo || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedTo)) {
    return { ok: false, error: `Invalid email address: ${to}` };
  }

  try {
    const payload: Record<string, unknown> = {
      from: fromEmail,
      to: [trimmedTo],
      subject,
      text,
    };
    if (options?.html) payload.html = options.html;
    if (options?.replyTo) payload.reply_to = options.replyTo;

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resendKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const bodyText = await response.text();
    let parsed: any = {};
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      /* ignore */
    }

    if (response.ok) return { ok: true, id: parsed?.id };
    return {
      ok: false,
      error: `Email failed (${response.status}): ${parsed?.message || bodyText || 'unknown error'}`,
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'Unknown email error' };
  }
}

export async function sendSmsNotification(
  phone: string,
  body: string
): Promise<{ ok: boolean; error?: string }> {
  const twilioSid = process.env.TWILIO_ACCOUNT_SID;
  const twilioToken = process.env.TWILIO_AUTH_TOKEN;
  const twilioFrom = process.env.TWILIO_PHONE_NUMBER;

  if (!twilioSid || !twilioToken || !twilioFrom) {
    return {
      ok: false,
      error: 'SMS service not configured. Add TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER.',
    };
  }

  const to = formatPhoneE164(phone);
  if (!to) {
    return { ok: false, error: `Invalid phone number: ${phone}` };
  }

  try {
    const twilioAuth = Buffer.from(`${twilioSid}:${twilioToken}`).toString('base64');
    const params = new URLSearchParams({
      To: to,
      From: twilioFrom,
      Body: body.slice(0, 1600),
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

    if (response.ok) return { ok: true };
    const errBody = await response.text();
    return { ok: false, error: `SMS failed: ${errBody}` };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'Unknown SMS error' };
  }
}