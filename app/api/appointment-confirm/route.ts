import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { settingsDocId } from '@/lib/appointment-reminders';
import { clientIp, rateLimit, tooManyRequests, serverError } from '@/lib/rate-limit';
import { sendEmailNotification } from '@/lib/notifications';
import {
  buildAppointmentNotifyMessages,
  formatAppointmentWhen,
  type AppointmentNotifyStatus,
} from '@/lib/appointment-notify';
import {
  buildOwnerConfirmedMessages,
  confirmHashMatches,
  isConfirmExpired,
  parseConfirmToken,
  publicNotifyStatus,
} from '@/lib/appointment-confirm';

export const dynamic = 'force-dynamic';

const DAY = 24 * 60 * 60;

type ConfirmView = {
  companyName: string;
  jobName: string;
  reference: string;
  formattedWhen: string;
  location: string;
  alreadyConfirmed: boolean;
  confirmedAt: string | null;
  expired: boolean;
};

function publicError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

async function limitConfirm(request: NextRequest, kind: 'get' | 'post', tokenHint: string) {
  const ip = clientIp(request);
  const perIp =
    kind === 'get'
      ? await rateLimit(`appt-confirm:get:ip:${ip}`, 60 * 60, 60)
      : await rateLimit(`appt-confirm:post:ip:${ip}`, 60 * 60, 10);
  if (!perIp.allowed) {
    return tooManyRequests(perIp, 'Too many attempts. Please wait and try again.');
  }
  if (kind === 'post' && tokenHint) {
    const perToken = await rateLimit(`appt-confirm:post:t:${tokenHint.slice(0, 40)}`, 60 * 60, 20);
    if (!perToken.allowed) {
      return tooManyRequests(perToken, 'Too many attempts. Please wait and try again.');
    }
  }
  const global = await rateLimit(
    `appt-confirm:${kind}:global`,
    DAY,
    kind === 'get' ? 4000 : 800
  );
  if (!global.allowed) {
    return tooManyRequests(global, 'This page is busy. Please try again in a little while.');
  }
  return null;
}

function snapshotFromNotify(
  notify: AppointmentNotifyStatus | undefined,
  estimate: Record<string, any>
): ConfirmView {
  const jobName = String(notify?.jobName || estimate.jobName || '').trim();
  const reference = String(estimate.invoiceNumber || estimate.invoicenumber || estimate.id || '').trim();
  const timeZone = notify?.timeZone;
  const formattedWhen =
    String(notify?.formattedWhen || '').trim() ||
    formatAppointmentWhen(String(notify?.confirmExpiresAt || ''), timeZone);
  const location = String(notify?.location || '').trim();
  const companyName = String(notify?.companyName || '').trim() || 'Your contractor';
  return {
    companyName,
    jobName,
    reference,
    formattedWhen,
    location,
    alreadyConfirmed: Boolean(notify?.confirmedAt),
    confirmedAt: notify?.confirmedAt || null,
    expired: isConfirmExpired(notify?.confirmExpiresAt),
  };
}

async function loadByToken(tokenRaw: string) {
  const parsed = parseConfirmToken(tokenRaw);
  if (!parsed.ok) return { error: 'This confirmation link is invalid or has expired.', status: 400 as const };

  const admin = getSupabaseAdmin();
  if (!admin) {
    return { error: 'This confirmation link is temporarily unavailable.', status: 500 as const };
  }

  const { data: row, error } = await admin
    .from('estimates')
    .select('id, user_id, jobName, invoiceNumber, invoicenumber, address, city, state, zipCode, profile')
    .eq('id', parsed.estimateId)
    .maybeSingle();

  if (error) {
    console.warn('appointment-confirm lookup:', error.message);
    return { error: 'This confirmation link is temporarily unavailable.', status: 500 as const };
  }
  if (!row?.id) {
    return { error: 'This confirmation link is invalid or has expired.', status: 400 as const };
  }

  const profile = row.profile && typeof row.profile === 'object' ? (row.profile as Record<string, unknown>) : {};
  const notify = (profile._appointmentNotify || null) as AppointmentNotifyStatus | null;
  if (!notify || !confirmHashMatches(parsed.token, notify.confirmTokenHash)) {
    return { error: 'This confirmation link is invalid or has expired.', status: 400 as const };
  }

  return { row, profile, notify, parsed, admin };
}

/** Public read of the appointment. GET never confirms (link-preview bots must not confirm). */
export async function GET(request: NextRequest) {
  try {
    const token = String(request.nextUrl.searchParams.get('t') || request.nextUrl.searchParams.get('token') || '').trim();
    const limited = await limitConfirm(request, 'get', token);
    if (limited) return limited;
    if (!token) return publicError('This confirmation link is invalid or has expired.', 400);

    const loaded = await loadByToken(token);
    if ('error' in loaded && loaded.error) return publicError(loaded.error, loaded.status);

    const { row, notify, admin } = loaded as Awaited<ReturnType<typeof loadByToken>> & {
      row: any;
      notify: AppointmentNotifyStatus;
      admin: NonNullable<ReturnType<typeof getSupabaseAdmin>>;
    };

    let view = snapshotFromNotify(notify, row);
    if ((!view.companyName || view.companyName === 'Your contractor') && row.user_id) {
      try {
        const { data: settingsRow } = await admin
          .from('estimates')
          .select('profile')
          .eq('id', settingsDocId(row.user_id))
          .maybeSingle();
        const company = String((settingsRow?.profile as any)?.company || '').trim();
        if (company) view = { ...view, companyName: company };
      } catch {
        /* ignore */
      }
    }
    if (!view.location) {
      const fallback = buildAppointmentNotifyMessages({
        appointmentDateTime: notify.confirmExpiresAt || new Date().toISOString(),
        address: row.address,
        city: row.city,
        state: row.state,
        zipCode: row.zipCode,
        timeZone: notify.timeZone,
      });
      view = { ...view, location: fallback.location };
    }

    return NextResponse.json({
      ok: true,
      ...view,
      // Never confirm on GET.
      confirmed: Boolean(notify.confirmedAt),
    });
  } catch (e) {
    return serverError('appointment-confirm GET', e, 'This confirmation link is temporarily unavailable.');
  }
}

/** Customer confirms the appointment. Idempotent. */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const token = String(body.token || body.t || '').trim();
    const limited = await limitConfirm(request, 'post', token);
    if (limited) return limited;
    if (!token) return publicError('This confirmation link is invalid or has expired.', 400);

    const loaded = await loadByToken(token);
    if ('error' in loaded && loaded.error) return publicError(loaded.error, loaded.status);

    const { row, profile, notify, admin } = loaded as Awaited<ReturnType<typeof loadByToken>> & {
      row: any;
      profile: Record<string, unknown>;
      notify: AppointmentNotifyStatus;
      admin: NonNullable<ReturnType<typeof getSupabaseAdmin>>;
    };

    if (isConfirmExpired(notify.confirmExpiresAt) && !notify.confirmedAt) {
      return publicError('This appointment time has passed, so the confirmation link has expired.', 410);
    }

    let confirmedAt = notify.confirmedAt || '';
    let already = Boolean(notify.confirmedAt);
    const now = new Date().toISOString();

    if (!already) {
      confirmedAt = now;
      const nextNotify: AppointmentNotifyStatus = {
        ...notify,
        confirmedAt,
      };
      const { error: writeErr } = await admin
        .from('estimates')
        .update({
          profile: { ...profile, _appointmentNotify: nextNotify },
          updated_at: now,
        })
        .eq('id', row.id)
        .eq('user_id', row.user_id);

      if (writeErr) {
        console.warn('appointment-confirm write:', writeErr.message);
        return publicError('Could not confirm this appointment. Please try again.', 500);
      }

      try {
        await syncSettingsAppointment(admin, row.user_id, row.id, publicNotifyStatus(nextNotify)!);
      } catch (err) {
        console.warn('appointment-confirm settings sync:', err);
      }

      try {
        await notifyOwner(admin, row.user_id, nextNotify);
      } catch (err) {
        console.warn('appointment-confirm owner notice:', err);
      }
    }

    const view = snapshotFromNotify({ ...notify, confirmedAt }, row);
    return NextResponse.json({
      ok: true,
      ...view,
      confirmed: true,
      alreadyConfirmed: already,
    });
  } catch (e) {
    return serverError('appointment-confirm POST', e, 'Could not confirm this appointment. Please try again.');
  }
}

async function syncSettingsAppointment(
  admin: NonNullable<ReturnType<typeof getSupabaseAdmin>>,
  userId: string,
  estimateId: string,
  notify: AppointmentNotifyStatus
) {
  const settingsId = settingsDocId(userId);
  const { data: settingsRow } = await admin
    .from('estimates')
    .select('id, profile')
    .eq('id', settingsId)
    .eq('user_id', userId)
    .maybeSingle();
  if (!settingsRow?.id) return;
  const prev =
    settingsRow.profile && typeof settingsRow.profile === 'object'
      ? (settingsRow.profile as Record<string, unknown>)
      : {};
  const list = Array.isArray(prev._appointments) ? (prev._appointments as any[]) : [];
  if (!list.length) return;
  const next = list.map((appt) => {
    if (!appt || typeof appt !== 'object') return appt;
    const idMatch = Boolean(notify.appointmentId) && appt.id === notify.appointmentId;
    const estMatch = !notify.appointmentId && estimateId && appt.estimateId === estimateId;
    if (idMatch || estMatch) {
      return { ...appt, notify: { ...(appt.notify || {}), ...notify } };
    }
    return appt;
  });
  const changed = next.some((appt, i) => appt !== list[i]);
  if (!changed) return;
  const { error } = await admin
    .from('estimates')
    .update({
      profile: { ...prev, _appointments: next },
      updated_at: new Date().toISOString(),
    })
    .eq('id', settingsId)
    .eq('user_id', userId);
  if (error) console.warn('appointment-confirm settings write:', error.message);
}

async function notifyOwner(
  admin: NonNullable<ReturnType<typeof getSupabaseAdmin>>,
  userId: string,
  notify: AppointmentNotifyStatus
) {
  const { data: settingsRow } = await admin
    .from('estimates')
    .select('profile')
    .eq('id', settingsDocId(userId))
    .maybeSingle();
  const profile = (settingsRow?.profile || {}) as Record<string, unknown>;
  const to = String(profile.email || '').trim();
  if (!to || !to.includes('@')) return;
  const msg = buildOwnerConfirmedMessages({
    jobName: notify.jobName,
    invoiceNumber: undefined,
    customerName: notify.customerName,
    formattedWhen: notify.formattedWhen,
    timeZone: notify.timeZone,
    companyName: notify.companyName,
    location: notify.location,
  });
  await sendEmailNotification(to, msg.subject, msg.emailText, {
    html: msg.emailHtml,
    idempotencyKey: `appt-confirmed:${userId}:${notify.appointmentId || 'appt'}`.slice(0, 200),
  });
}
