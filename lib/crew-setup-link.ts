/**
 * Crew logins are created WITHOUT a password. Once the seat is paid (login enabled),
 * the crew member gets a one-time "set your password" link at their own email, so
 * the owner never knows (or sets) a crew member's password and nobody can sign in to
 * an address they do not control.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { sendEmailNotification } from '@/lib/notifications';
import { rateLimit } from '@/lib/rate-limit';
import { getAppUrl } from '@/lib/stripe-server';

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

/** Find an auth user by email, paging through every user (no 1000-user cap). */
export async function findAuthUserByEmail(
  admin: SupabaseClient,
  email: string
): Promise<{ id: string; app_metadata?: Record<string, unknown> } | null> {
  const target = email.trim().toLowerCase();
  const perPage = 1000;
  for (let page = 1; page <= 200; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error) throw new Error(`listUsers: ${error.message}`);
    const users = data?.users || [];
    const found = users.find((u) => (u.email || '').toLowerCase() === target);
    if (found) return { id: found.id, app_metadata: found.app_metadata as Record<string, unknown> };
    if (users.length < perPage) return null;
  }
  throw new Error('listUsers: too many pages');
}

/**
 * Email the crew member a one-time link that signs them in to /reset-password to
 * choose their own password. Rate limited per crew login. Never throws.
 */
export async function sendCrewSetupLink(
  admin: SupabaseClient,
  input: { crewUserId: string; email: string; ownerUserId: string; reason: 'activated' | 'resend' }
): Promise<{ ok: boolean; error?: string }> {
  try {
    const limit = await rateLimit(`crew-setup-link:${input.crewUserId}`, 60 * 60, 3);
    if (!limit.allowed) return { ok: false, error: 'A setup link was sent recently. Try again in an hour.' };

    const appUrl = getAppUrl();
    const { data, error } = await admin.auth.admin.generateLink({
      type: 'recovery',
      email: input.email,
      options: { redirectTo: `${appUrl}/reset-password` },
    });
    const link = data?.properties?.action_link;
    if (error || !link) return { ok: false, error: error?.message || 'Could not create setup link' };

    let company = 'Your contractor';
    const { data: settings } = await admin
      .from('estimates')
      .select('profile')
      .eq('id', `SETTINGS-${input.ownerUserId}`)
      .eq('user_id', input.ownerUserId)
      .maybeSingle();
    const name = String((settings?.profile as { company?: unknown } | null)?.company || '').trim();
    if (name) company = name.slice(0, 80);

    const subject = `${company} added you to their EstimateAce crew`;
    const text = [
      `${company} added you as a crew member on EstimateAce.`,
      '',
      'Set your password to sign in (this link works once and expires soon):',
      link,
      '',
      `After that, sign in at ${appUrl} with this email address.`,
      'If the link expired, use "Forgot your password?" on the sign-in page.',
      '',
      "If you weren't expecting this, you can ignore this email.",
    ].join('\n');
    const html = `<p>${escapeHtml(company)} added you as a crew member on EstimateAce.</p>
<p><a href="${escapeHtml(link)}" style="display:inline-block;padding:12px 18px;background:#10b981;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">Set your password</a></p>
<p style="color:#64748b;font-size:13px">This link works once and expires soon. Afterwards, sign in at <a href="${escapeHtml(appUrl)}">${escapeHtml(appUrl)}</a> with this email. If it expired, use &ldquo;Forgot your password?&rdquo; on the sign-in page.</p>
<p style="color:#94a3b8;font-size:12px">If you weren't expecting this, you can ignore this email.</p>`;
    const sent = await sendEmailNotification(input.email, subject, text, { html });
    if (!sent.ok) return { ok: false, error: sent.error };

    const { data: got } = await admin.auth.admin.getUserById(input.crewUserId);
    await admin.auth.admin.updateUserById(input.crewUserId, {
      app_metadata: {
        ...(got?.user?.app_metadata || {}),
        crew_setup_sent_at: new Date().toISOString(),
      },
    });
    return { ok: true };
  } catch (e) {
    console.warn('sendCrewSetupLink:', (e as Error)?.message || e);
    return { ok: false, error: 'Could not send setup link' };
  }
}
