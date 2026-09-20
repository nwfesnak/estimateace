/**
 * Inbound email leads via forward-to address (any provider).
 * Works with Gmail, Outlook, Yahoo, Apple Mail, Zoho, etc. — user forwards
 * their business inbox to a unique EstimateAce address; we summarize into
 * SETTINGS.emailLeadSummaries for the dashboard.
 */
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import type { EmailLeadSummary } from '@/lib/ai-receptionist';
import { getXaiApiKey, getXaiChatModel } from '@/lib/xai-config';

function settingsId(userId: string) {
  return `SETTINGS-${userId}`;
}

/** Domain that receives forwarded lead emails (MX must point at Resend inbound). */
export function getEmailInboundDomain(): string {
  return (
    process.env.EMAIL_INBOUND_DOMAIN?.trim() ||
    process.env.NEXT_PUBLIC_EMAIL_INBOUND_DOMAIN?.trim() ||
    'inbound.estimateace.com'
  );
}

/** Deterministic local-part from Supabase user id (uuid → 32 hex). */
export function userIdToInboundLocal(userId: string): string {
  const hex = String(userId || '')
    .replace(/-/g, '')
    .toLowerCase()
    .replace(/[^0-9a-f]/g, '');
  if (hex.length < 32) return '';
  return `u${hex.slice(0, 32)}`;
}

export function inboundLocalToUserId(local: string): string | null {
  const m = String(local || '')
    .trim()
    .toLowerCase()
    .match(/^u([0-9a-f]{32})$/);
  if (!m) return null;
  const h = m[1];
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export function getInboundAddressForUser(userId: string): string {
  const local = userIdToInboundLocal(userId);
  if (!local) return '';
  return `${local}@${getEmailInboundDomain()}`;
}

/** Extract EstimateAce user id from To / received_for addresses. */
export function resolveUserIdFromRecipients(
  recipients: Array<string | null | undefined>
): string | null {
  const domain = getEmailInboundDomain().toLowerCase();
  for (const raw of recipients) {
    const addr = String(raw || '')
      .replace(/^.*</, '')
      .replace(/>.*$/, '')
      .trim()
      .toLowerCase();
    if (!addr.includes('@')) continue;
    const [local, host] = addr.split('@');
    if (!local || !host) continue;
    if (host !== domain && !host.endsWith(`.${domain}`)) {
      // Still try parse — Resend may deliver to *.resend.app while received_for has our alias
    }
    const uid = inboundLocalToUserId(local);
    if (uid) return uid;
  }
  // Second pass: any local that looks like ours, regardless of host
  for (const raw of recipients) {
    const addr = String(raw || '')
      .replace(/^.*</, '')
      .replace(/>.*$/, '')
      .trim()
      .toLowerCase();
    const local = addr.split('@')[0] || '';
    const uid = inboundLocalToUserId(local);
    if (uid) return uid;
  }
  return null;
}

function parseFromHeader(from: string): { name: string; email: string } {
  const s = String(from || '').trim();
  const angle = s.match(/^(.*)<([^>]+)>\s*$/);
  if (angle) {
    return {
      name: angle[1].replace(/["']/g, '').trim() || angle[2].trim(),
      email: angle[2].trim(),
    };
  }
  if (s.includes('@')) return { name: s, email: s };
  return { name: s || 'Unknown', email: '' };
}

function stripHtml(html: string): string {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function summarizeInboundEmail(input: {
  subject: string;
  fromName: string;
  fromEmail: string;
  bodyText: string;
}): Promise<string> {
  const body = String(input.bodyText || '').slice(0, 6000);
  const subject = String(input.subject || '(no subject)');
  const fallback =
    body.slice(0, 280) ||
    `Email from ${input.fromName || input.fromEmail || 'unknown'}: ${subject}`;

  const key = getXaiApiKey();
  if (!key) return fallback;

  try {
    const res = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: getXaiChatModel(),
        temperature: 0.2,
        max_tokens: 220,
        messages: [
          {
            role: 'system',
            content:
              'You summarize contractor lead emails for a busy owner. Write 2–3 short sentences: who contacted, what they want, and any phone/address/timeline. No fluff. If spam/marketing, say so in one line.',
          },
          {
            role: 'user',
            content: `From: ${input.fromName} <${input.fromEmail}>\nSubject: ${subject}\n\n${body || '(empty body)'}`,
          },
        ],
      }),
    });
    if (!res.ok) return fallback;
    const json = await res.json().catch(() => ({}));
    const text = String(json?.choices?.[0]?.message?.content || '').trim();
    return text.slice(0, 800) || fallback;
  } catch {
    return fallback;
  }
}

export async function appendEmailLeadSummary(input: {
  userId: string;
  fromName?: string;
  fromEmail?: string;
  subject?: string;
  summary: string;
  status?: EmailLeadSummary['status'];
}): Promise<EmailLeadSummary | null> {
  const admin = getSupabaseAdmin();
  if (!admin) return null;

  const sid = settingsId(input.userId);
  const { data } = await admin.from('estimates').select('profile').eq('id', sid).maybeSingle();
  const profile = (data?.profile && typeof data.profile === 'object' ? data.profile : {}) as any;
  const existing: EmailLeadSummary[] = Array.isArray(profile.emailLeadSummaries)
    ? profile.emailLeadSummaries
    : [];

  const msg: EmailLeadSummary = {
    id: `email-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    createdAt: new Date().toISOString(),
    fromName: String(input.fromName || 'Unknown').slice(0, 120),
    fromEmail: String(input.fromEmail || '').slice(0, 200),
    subject: String(input.subject || '(no subject)').slice(0, 300),
    summary: String(input.summary || '').slice(0, 2000),
    status: input.status || 'new',
  };

  const { error } = await admin.from('estimates').upsert({
    id: sid,
    user_id: input.userId,
    jobName: '__settings__',
    documentType: 'settings',
    items: [],
    invoiceNumber: sid,
    profile: {
      ...profile,
      emailLeadSummaries: [msg, ...existing].slice(0, 200),
    },
    updated_at: new Date().toISOString(),
  });
  if (error) {
    console.error('appendEmailLeadSummary:', error.message);
    return null;
  }
  return msg;
}

export async function fetchResendReceivedEmail(emailId: string): Promise<{
  from: string;
  subject: string;
  text: string;
  html: string;
  to: string[];
  received_for: string[];
} | null> {
  const key = process.env.RESEND_API_KEY?.trim();
  if (!key || !emailId) return null;
  const res = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!res.ok) {
    console.warn('Resend receiving.get failed', res.status, await res.text().catch(() => ''));
    return null;
  }
  const data = await res.json();
  const text = String(data.text || '').trim();
  const html = String(data.html || '').trim();
  return {
    from: String(data.from || ''),
    subject: String(data.subject || '(no subject)'),
    text: text || stripHtml(html),
    html,
    to: Array.isArray(data.to) ? data.to.map(String) : [],
    received_for: Array.isArray(data.received_for) ? data.received_for.map(String) : [],
  };
}

export { parseFromHeader, stripHtml };
