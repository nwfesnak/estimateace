/**
 * Unguessable customer appointment confirmation tokens.
 *
 * The public URL carries a token of the form `{base64url(estimateId)}.{secret}`.
 * The estimate id is only a locator (it is the document PK); the secret is 18
 * random bytes. Only the SHA-256 hash is stored on
 * estimates.profile._appointmentNotify — reschedule overwrites it, so old links
 * stop working. Tokens expire at the appointment time.
 *
 * Confirmation is stored on the same JSONB object (confirmedAt). No migration.
 */

import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { getPublicSiteUrl } from '@/lib/sms-compliance';
import {
  formatAppointmentWhen,
  resolveNotifyTimeZone,
  type AppointmentNotifyStatus,
} from '@/lib/appointment-notify';

const SECRET_BYTES = 18;

export type ParsedConfirmToken =
  | { ok: true; estimateId: string; secret: string; token: string }
  | { ok: false; error: string };

export function b64urlEncode(input: string): string {
  return Buffer.from(input, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

export function b64urlDecode(s: string): string | null {
  try {
    const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
    const out = Buffer.from(b64, 'base64').toString('utf8');
    return out || null;
  } catch {
    return null;
  }
}

export function generateConfirmSecret(): string {
  return randomBytes(SECRET_BYTES).toString('base64url');
}

export function buildConfirmToken(estimateId: string, secret: string): string {
  return `${b64urlEncode(String(estimateId || '').trim())}.${String(secret || '').trim()}`;
}

export function parseConfirmToken(raw: string | null | undefined): ParsedConfirmToken {
  const token = String(raw || '').trim();
  if (!token || token.length > 400 || !token.includes('.')) {
    return { ok: false, error: 'Invalid link' };
  }
  const dot = token.indexOf('.');
  const locator = token.slice(0, dot);
  const secret = token.slice(dot + 1);
  if (!locator || !secret || secret.length < 16 || /[^A-Za-z0-9_-]/.test(secret + locator)) {
    return { ok: false, error: 'Invalid link' };
  }
  const estimateId = b64urlDecode(locator);
  if (!estimateId || estimateId.length > 120) return { ok: false, error: 'Invalid link' };
  return { ok: true, estimateId, secret, token };
}

export function hashConfirmToken(token: string): string {
  return createHash('sha256').update(String(token || ''), 'utf8').digest('hex');
}

export function confirmHashMatches(token: string, storedHash: string | null | undefined): boolean {
  const expectedHex = String(storedHash || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expectedHex)) return false;
  const actualHex = hashConfirmToken(token);
  const a = Buffer.from(actualHex, 'hex');
  const b = Buffer.from(expectedHex, 'hex');
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** True once the appointment time has passed (token is no longer valid to confirm). */
export function isConfirmExpired(expiresAt: string | null | undefined, now = new Date()): boolean {
  const exp = new Date(String(expiresAt || ''));
  if (Number.isNaN(exp.getTime())) return true;
  return now.getTime() > exp.getTime();
}

export function issueAppointmentConfirm(
  estimateId: string,
  appointmentDateTime: string
): { token: string; hash: string; expiresAt: string } {
  const id = String(estimateId || '').trim();
  const expiresAt = new Date(appointmentDateTime).toISOString();
  const token = buildConfirmToken(id, generateConfirmSecret());
  return { token, hash: hashConfirmToken(token), expiresAt };
}

export function appointmentConfirmUrl(token?: string | null, baseUrl?: string): string {
  const base = String(baseUrl || getPublicSiteUrl() || 'https://app.estimateace.com').replace(/\/$/, '');
  const t = String(token || '').trim();
  return t
    ? `${base}/appointment/confirm?t=${encodeURIComponent(t)}`
    : `${base}/appointment/confirm`;
}

/** Drop the stored hash before sending status to the browser or SETTINGS calendar list. */
export function publicNotifyStatus(
  status: AppointmentNotifyStatus | null | undefined
): AppointmentNotifyStatus | undefined {
  if (!status || typeof status !== 'object') return undefined;
  const { confirmTokenHash: _hash, ...rest } = status;
  return rest;
}

export function readNotifyFromEstimate(
  estimate: Record<string, unknown> | null | undefined
): AppointmentNotifyStatus | undefined {
  if (!estimate || typeof estimate !== 'object') return undefined;
  const profile =
    estimate.profile && typeof estimate.profile === 'object'
      ? (estimate.profile as Record<string, unknown>)
      : {};
  const raw = profile._appointmentNotify;
  if (!raw || typeof raw !== 'object') return undefined;
  return publicNotifyStatus(raw as AppointmentNotifyStatus);
}

export function notificationWasSent(status?: AppointmentNotifyStatus | null): boolean {
  return status?.status === 'notified' || status?.status === 'partial';
}

export type ConfirmationBadge = {
  kind: 'confirmed' | 'awaiting' | 'none';
  text: string;
  confirmedAt?: string;
  confirmedLabel?: string;
};

export function formatConfirmedAt(iso: string, timeZone?: string): string {
  const tz = resolveNotifyTimeZone(timeZone);
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-US', {
    timeZone: tz,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

export function confirmationBadge(
  status?: AppointmentNotifyStatus | null,
  timeZone?: string
): ConfirmationBadge {
  if (!notificationWasSent(status)) return { kind: 'none', text: '' };
  if (status?.confirmedAt) {
    const confirmedLabel = formatConfirmedAt(status.confirmedAt, timeZone || status.timeZone);
    return {
      kind: 'confirmed',
      text: confirmedLabel ? `Confirmed by customer · ${confirmedLabel}` : 'Confirmed by customer',
      confirmedAt: status.confirmedAt,
      confirmedLabel,
    };
  }
  return { kind: 'awaiting', text: 'Awaiting confirmation' };
}

export function mergeAppointmentNotify(
  appointment: { id: string; notify?: AppointmentNotifyStatus },
  fromEstimate?: AppointmentNotifyStatus | null
): AppointmentNotifyStatus | undefined {
  const incoming = publicNotifyStatus(fromEstimate || undefined);
  if (!incoming) return publicNotifyStatus(appointment.notify);
  if (incoming.appointmentId && incoming.appointmentId !== appointment.id) {
    return publicNotifyStatus(appointment.notify);
  }
  return incoming;
}

export function buildOwnerConfirmedMessages(input: {
  jobName?: string;
  invoiceNumber?: string;
  customerName?: string;
  formattedWhen?: string;
  appointmentDateTime?: string;
  timeZone?: string;
  companyName?: string;
  location?: string;
}): { subject: string; emailText: string; emailHtml: string } {
  const job = String(input.jobName || '').trim() || 'your job';
  const ref = String(input.invoiceNumber || '').trim();
  const who = String(input.customerName || '').trim() || 'A customer';
  const when =
    String(input.formattedWhen || '').trim() ||
    (input.appointmentDateTime ? formatAppointmentWhen(input.appointmentDateTime, input.timeZone) : '');
  const subject = `${job} appointment confirmed`;
  const emailText = [
    'Hello,',
    '',
    `${who} confirmed the appointment for ${job}${when ? ` on ${when}` : ''}${ref ? ` (${ref})` : ''}.`,
    '',
    "You'll see a green check mark on your calendar and on the job.",
    '',
    '— EstimateAce',
  ].join('\n');
  const emailHtml = `<!DOCTYPE html>
<html><body style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#0f172a;line-height:1.5;max-width:560px;margin:0 auto;padding:24px;">
  <div style="border-top:6px solid #10b981;border-radius:16px;padding:8px 0 0;">
    <p style="margin:0 0 4px;font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:#0f766e;font-weight:700;">EstimateAce</p>
    <h1 style="font-size:22px;margin:0 0 16px;">Appointment confirmed</h1>
    <p style="margin:0 0 16px;">${escapeHtml(who)} confirmed the appointment for <strong>${escapeHtml(job)}</strong>${when ? ` on ${escapeHtml(when)}` : ''}${ref ? ` (${escapeHtml(ref)})` : ''}.</p>
    <p style="margin:0;color:#334155;">You'll see a green check mark on your calendar and on the job.</p>
    <p style="margin:24px 0 0;color:#475569;">— EstimateAce</p>
  </div>
</body></html>`;
  return { subject, emailText, emailHtml };
}

function escapeHtml(s: string): string {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
