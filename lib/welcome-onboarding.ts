/**
 * Auto welcome email + SMS after signup / start-trial.
 * No CRM — uses existing Resend + Twilio. Link comes from WELCOME_VIDEO_URL.
 */
import { sendEmailNotification, sendSmsNotification } from '@/lib/notifications';

export function getWelcomeVideoUrl(): string {
  return (
    process.env.WELCOME_VIDEO_URL ||
    process.env.NEXT_PUBLIC_WELCOME_VIDEO_URL ||
    ''
  ).trim();
}

export function getWelcomeAppUrl(): string {
  return (
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.NEXT_PUBLIC_SITE_URL ||
    'https://app.estimateace.com'
  )
    .trim()
    .replace(/\/$/, '');
}

function firstName(name: string, email: string): string {
  const n = String(name || '').trim();
  if (n) return n.split(/\s+/)[0];
  const local = String(email || '').split('@')[0];
  return local || 'there';
}

export function buildWelcomeSms(input: {
  name?: string;
  email?: string;
  videoUrl: string;
}): string {
  const who = firstName(input.name || '', input.email || '');
  const appUrl = getWelcomeAppUrl();
  return (
    `Hi ${who} — welcome to EstimateAce! ` +
    `Watch this quick walkthrough: ${input.videoUrl} ` +
    `Then log in at ${appUrl} to build your first estimate. ` +
    `Reply STOP to opt out of texts.`
  ).slice(0, 1500);
}

export function buildWelcomeEmail(input: {
  name?: string;
  email: string;
  videoUrl: string;
  company?: string;
}): { subject: string; text: string; html: string } {
  const who = firstName(input.name || '', input.email);
  const appUrl = getWelcomeAppUrl();
  const companyLine = input.company ? ` for ${input.company}` : '';
  const subject = 'Welcome to EstimateAce — quick walkthrough video';
  const text = [
    `Hi ${who},`,
    '',
    `Welcome to EstimateAce${companyLine}!`,
    '',
    `Here’s a short video that walks you through the app:`,
    input.videoUrl,
    '',
    `When you’re ready, log in and start your trial:`,
    appUrl,
    '',
    `Tip: on your phone, open the app link in Safari (iPhone) or Chrome (Android) and Add to Home Screen so it feels like a regular app.`,
    '',
    `Questions? Reply to this email or contact support@estimateace.com.`,
    '',
    `— EstimateAce`,
  ].join('\n');

  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;line-height:1.5;color:#0f172a;max-width:560px">
      <p>Hi ${escapeHtml(who)},</p>
      <p><strong>Welcome to EstimateAce${escapeHtml(companyLine)}!</strong></p>
      <p>Here’s a short video that walks you through the app:</p>
      <p style="margin:20px 0">
        <a href="${escapeAttr(input.videoUrl)}"
           style="display:inline-block;background:#059669;color:#fff;text-decoration:none;padding:12px 18px;border-radius:10px;font-weight:700">
          Watch the walkthrough
        </a>
      </p>
      <p style="font-size:14px;color:#475569">Or open this link:<br/>
        <a href="${escapeAttr(input.videoUrl)}">${escapeHtml(input.videoUrl)}</a>
      </p>
      <p>When you’re ready, log in and start building estimates:</p>
      <p><a href="${escapeAttr(appUrl)}">${escapeHtml(appUrl)}</a></p>
      <p style="font-size:13px;color:#64748b">
        Tip: on your phone, open the app in Safari (iPhone) or Chrome (Android) and use
        <strong>Add to Home Screen</strong> so it opens like a regular app.
      </p>
      <p style="font-size:13px;color:#64748b">
        Questions? Reply to this email or contact
        <a href="mailto:support@estimateace.com">support@estimateace.com</a>.
      </p>
      <p>— EstimateAce</p>
    </div>
  `.trim();

  return { subject, text, html };
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/'/g, '&#39;');
}

export type WelcomeSendResult = {
  attempted: boolean;
  skippedReason?: string;
  email?: { ok: boolean; error?: string };
  sms?: { ok: boolean; error?: string };
};

/**
 * Send welcome email + SMS once. Caller should persist a "sent" flag after success.
 */
export async function sendWelcomeOnboarding(input: {
  email?: string | null;
  phone?: string | null;
  name?: string | null;
  company?: string | null;
}): Promise<WelcomeSendResult> {
  const videoUrl = getWelcomeVideoUrl();
  if (!videoUrl) {
    return {
      attempted: false,
      skippedReason:
        'WELCOME_VIDEO_URL is not set in Vercel. Add your YouTube/Loom/Vimeo (or MP4) link, then redeploy.',
    };
  }

  const email = String(input.email || '').trim();
  const phone = String(input.phone || '').trim();
  const name = String(input.name || '').trim();
  const company = String(input.company || '').trim();

  if (!email && !phone) {
    return { attempted: false, skippedReason: 'No email or phone on signup.' };
  }

  const result: WelcomeSendResult = { attempted: true };

  if (email && email.includes('@')) {
    const msg = buildWelcomeEmail({ name, email, videoUrl, company });
    result.email = await sendEmailNotification(email, msg.subject, msg.text, {
      html: msg.html,
    });
  }

  if (phone) {
    const smsBody = buildWelcomeSms({ name, email, videoUrl });
    result.sms = await sendSmsNotification(phone, smsBody, {
      skipOptInCheck: true, // transactional onboarding; includes STOP language
    });
  }

  return result;
}

/**
 * Send welcome once after landing-page signup (/api/billing/start-trial only).
 * Persists welcomeOnboardingSentAt on SETTINGS profile so later saves/logins never re-send.
 */
export async function maybeSendAndPersistWelcomeOnboarding(input: {
  admin: any;
  userId: string;
  email?: string | null;
  phone?: string | null;
  name?: string | null;
  company?: string | null;
}): Promise<WelcomeSendResult> {
  const settingsId = `SETTINGS-${input.userId}`;

  const { data: settings } = await input.admin
    .from('estimates')
    .select('profile')
    .eq('id', settingsId)
    .maybeSingle();

  const prev =
    settings?.profile && typeof settings.profile === 'object' ? settings.profile : {};

  if ((prev as any).welcomeOnboardingSentAt) {
    return { attempted: false, skippedReason: 'Welcome already sent.' };
  }

  const result = await sendWelcomeOnboarding({
    email: input.email || (prev as any).email || '',
    phone: input.phone || (prev as any).phone || '',
    name: input.name || (prev as any).name || '',
    company: input.company || (prev as any).company || '',
  });

  const emailed = result.email?.ok === true;
  const texted = result.sms?.ok === true;
  // Mark as sent whenever we attempted delivery with a configured video URL + contact,
  // even if one channel failed — so later logins never spam.
  const hasDestination = Boolean(
    input.email || input.phone || (prev as any).email || (prev as any).phone
  );
  const shouldMarkSent =
    emailed || texted || (result.attempted && Boolean(getWelcomeVideoUrl()) && hasDestination);

  if (!shouldMarkSent) {
    return result;
  }

  const sentAt = new Date().toISOString();
  const profile = {
    ...prev,
    email: input.email || (prev as any).email || '',
    phone: input.phone || (prev as any).phone || '',
    name: input.name || (prev as any).name || '',
    company: input.company || (prev as any).company || '',
    welcomeOnboardingSentAt: sentAt,
    welcomeOnboardingChannels: { email: emailed, sms: texted },
  };

  await input.admin.from('estimates').upsert({
    id: settingsId,
    user_id: input.userId,
    jobName: '__settings__',
    documentType: 'settings',
    items: [],
    profile,
    updated_at: sentAt,
  });

  return result;
}
