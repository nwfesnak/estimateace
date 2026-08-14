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

const DEFAULT_FROM_DOMAIN = 'estimateace.com';
const DEFAULT_PLATFORM_FROM = 'EstimateAce <notifications@estimateace.com>';

/** Domain used for outbound From addresses (must be verified in Resend). */
export function getNotificationFromDomain(): string {
  const fromEnv = (process.env.NOTIFICATION_FROM_DOMAIN || '').trim().toLowerCase();
  if (fromEnv) return fromEnv.replace(/^@/, '');

  const full = (process.env.NOTIFICATION_FROM_EMAIL || '').trim();
  const angle = full.match(/<([^>]+)>/);
  const addr = (angle?.[1] || full).trim();
  const at = addr.lastIndexOf('@');
  if (at > 0) {
    const domain = addr.slice(at + 1).toLowerCase();
    if (domain && !domain.includes('resend.dev')) return domain;
  }
  return DEFAULT_FROM_DOMAIN;
}

/**
 * Build a client-facing From header from the contractor company name.
 * Example: "Mitigation Hero" → Mitigation Hero <mitigationhero@estimateace.com>
 * Local-part is a slug of the company; domain must stay on the verified Resend domain.
 */
export function buildCompanyFromAddress(companyName?: string | null): string {
  const raw = String(companyName || '').trim();
  if (!raw) return DEFAULT_PLATFORM_FROM;

  // Strip characters unsafe in email display names
  const safeDisplay = raw.replace(/[<>\r\n"]/g, '').slice(0, 80) || 'EstimateAce';

  // "Mitigation Hero" → mitigationhero
  let local = safeDisplay
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 40);

  if (!local) local = 'notifications';

  const domain = getNotificationFromDomain();
  // Quote display name so Resend accepts names with spaces / punctuation
  const quoted = `"${safeDisplay.replace(/\\/g, '\\\\')}"`;
  return `${quoted} <${local}@${domain}>`;
}

export async function sendEmailNotification(
  to: string,
  subject: string,
  text: string,
  options?: {
    html?: string;
    replyTo?: string;
    /** When set, From becomes "Company Name <slug@yourdomain.com>" */
    companyName?: string;
    /** Override full From header (advanced) */
    from?: string;
  }
): Promise<{ ok: boolean; error?: string; id?: string }> {
  const resendKey = process.env.RESEND_API_KEY;

  let fromEmail =
    (options?.from || '').trim() ||
    (options?.companyName
      ? buildCompanyFromAddress(options.companyName)
      : (process.env.NOTIFICATION_FROM_EMAIL || '').trim() || DEFAULT_PLATFORM_FROM);

  if (!resendKey) {
    return { ok: false, error: 'Email service not configured. Add RESEND_API_KEY to Vercel (and redeploy).' };
  }

  const trimmedTo = String(to || '').trim();
  if (!trimmedTo || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedTo)) {
    return { ok: false, error: `Invalid email address: ${to}` };
  }

  // Guard: test domain cannot email clients
  if (/onboarding@resend\.dev/i.test(fromEmail)) {
    return {
      ok: false,
      error:
        'From address is still Resend test mode (onboarding@resend.dev). In Vercel set NOTIFICATION_FROM_EMAIL to EstimateAce <notifications@estimateace.com>, verify estimateace.com in Resend, then redeploy.',
    };
  }

  const platformFrom =
    (process.env.NOTIFICATION_FROM_EMAIL || '').trim() || DEFAULT_PLATFORM_FROM;

  const attemptSend = async (from: string) => {
    const payload: Record<string, unknown> = {
      from,
      to: [trimmedTo],
      subject,
      text,
    };
    if (options?.html) payload.html = options.html;
    if (options?.replyTo) {
      const rt = String(options.replyTo).trim();
      if (rt && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rt) && !/@estimateace\.com$/i.test(rt)) {
        // Reply-To can be contractor Gmail/etc.; skip if invalid
        payload.reply_to = rt;
      } else if (rt && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rt)) {
        payload.reply_to = rt;
      }
    }

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

    if (response.ok) return { ok: true as const, id: parsed?.id as string | undefined, from };
    const resendMsg = String(parsed?.message || bodyText || 'unknown error');
    return {
      ok: false as const,
      error: `Email failed (${response.status}) from ${from}: ${resendMsg}`,
      resendMsg,
      status: response.status,
    };
  };

  try {
    const first = await attemptSend(fromEmail);
    if (first.ok) return { ok: true, id: first.id };

    // Company-slug From addresses sometimes fail domain/validation — retry platform From
    const firstMsg = (first.resendMsg || first.error || '').toLowerCase();
    const shouldRetryPlatform =
      fromEmail !== platformFrom &&
      (/domain|from|not verified|invalid|forbidden|unauthorized|403|422|451/i.test(firstMsg) ||
        first.status === 403 ||
        first.status === 422 ||
        first.status === 451);

    if (shouldRetryPlatform) {
      console.warn('[email] retry with platform From after:', first.error);
      const second = await attemptSend(platformFrom);
      if (second.ok) return { ok: true, id: second.id };
      return {
        ok: false,
        error: `${first.error} · retry: ${second.error}`,
      };
    }

    return { ok: false, error: first.error };
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