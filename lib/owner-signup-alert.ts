/**
 * Email + SMS the EstimateAce owner once when a contractor creates an account.
 * Welcome mail to the new contractor stays in welcome-onboarding.ts.
 */
import { sendEmailNotification, sendSmsNotification } from '@/lib/notifications';

const DEFAULT_OWNER_EMAILS = ['support@estimateace.com', 'nwfesnak@gmail.com'];
/** Mitigation Hero / owner mobile. Override with PLATFORM_OWNER_ALERT_PHONE. */
const DEFAULT_OWNER_PHONE = '7045767062';

export function getOwnerAlertEmails(): string[] {
  const raw = (
    process.env.PLATFORM_OWNER_ALERT_EMAIL ||
    process.env.ADMIN_EMAIL ||
    ''
  ).trim();
  const fromEnv = raw
    .split(/[,;\s]+/)
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.includes('@'));
  const list = fromEnv.length ? fromEnv : DEFAULT_OWNER_EMAILS;
  return [...new Set(list)];
}

export function getOwnerAlertPhone(): string {
  return (process.env.PLATFORM_OWNER_ALERT_PHONE || '').trim() || DEFAULT_OWNER_PHONE;
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function line(label: string, value: string): string {
  const v = String(value || '').trim();
  return v ? `${label}: ${v}` : '';
}

export function buildOwnerSignupAlert(input: {
  email?: string | null;
  phone?: string | null;
  name?: string | null;
  company?: string | null;
  plan?: string | null;
}): { subject: string; text: string; html: string; sms: string } {
  const email = String(input.email || '').trim();
  const phone = String(input.phone || '').trim();
  const name = String(input.name || '').trim();
  const company = String(input.company || '').trim();
  const plan = String(input.plan || '').trim();
  const when = new Date().toLocaleString('en-US', {
    timeZone: 'America/New_York',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  const who = company || name || email || 'New account';
  const subject = `New EstimateAce account — ${who}`.slice(0, 180);
  const rows = [
    line('Name', name),
    line('Company', company),
    line('Email', email),
    line('Phone', phone),
    line('Plan', plan),
    `Time: ${when} ET`,
  ].filter(Boolean);

  const text = ['Someone just created an EstimateAce account.', '', ...rows].join('\n');
  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;line-height:1.5;color:#0f172a">
      <p><strong>Someone just created an EstimateAce account.</strong></p>
      ${rows.map((r) => `<p style="margin:4px 0">${escapeHtml(r)}</p>`).join('')}
    </div>
  `.trim();

  const sms = `EstimateAce signup: ${who}${email && who !== email ? ` ${email}` : ''}${
    phone ? ` ${phone}` : ''
  }${plan ? ` (${plan})` : ''}`.slice(0, 320);

  return { subject, text, html, sms };
}

export type OwnerSignupAlertResult = {
  attempted: boolean;
  skippedReason?: string;
  email?: { ok: boolean; error?: string };
  sms?: { ok: boolean; error?: string };
};

/**
 * Send once per account. Persists ownerSignupAlertSentAt on SETTINGS.
 */
export async function maybeSendOwnerSignupAlert(input: {
  admin: any;
  userId: string;
  email?: string | null;
  phone?: string | null;
  name?: string | null;
  company?: string | null;
  plan?: string | null;
}): Promise<OwnerSignupAlertResult> {
  const settingsId = `SETTINGS-${input.userId}`;
  const { data: settings } = await input.admin
    .from('estimates')
    .select('profile')
    .eq('id', settingsId)
    .maybeSingle();

  const prev =
    settings?.profile && typeof settings.profile === 'object' ? settings.profile : {};

  if ((prev as any).ownerSignupAlertSentAt) {
    return { attempted: false, skippedReason: 'Owner already alerted for this account.' };
  }

  const msg = buildOwnerSignupAlert(input);
  const result: OwnerSignupAlertResult = { attempted: true };

  const emailErrors: string[] = [];
  let emailed = false;
  for (const to of getOwnerAlertEmails()) {
    const sent = await sendEmailNotification(to, msg.subject, msg.text, { html: msg.html });
    if (sent.ok) emailed = true;
    else if (sent.error) emailErrors.push(`${to}: ${sent.error}`);
  }
  result.email = emailed
    ? { ok: true }
    : { ok: false, error: emailErrors.join(' · ') || 'No owner email sent.' };

  const sms = await sendSmsNotification(getOwnerAlertPhone(), msg.sms, {
    skipOptInCheck: true,
  });
  result.sms = { ok: sms.ok, error: sms.error };

  if (!emailed && !sms.ok) {
    return result;
  }

  const sentAt = new Date().toISOString();
  await input.admin.from('estimates').upsert({
    id: settingsId,
    user_id: input.userId,
    jobName: '__settings__',
    documentType: 'settings',
    items: [],
    profile: {
      ...prev,
      ownerSignupAlertSentAt: sentAt,
      ownerSignupAlertChannels: { email: emailed, sms: sms.ok === true },
    },
    updated_at: sentAt,
  });

  return result;
}
