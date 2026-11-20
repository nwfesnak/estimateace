/**
 * Production wiring for runTrialInactivity: Supabase (service role), Stripe, Resend,
 * private `account-exports` bucket, and the existing full account deletion.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type Stripe from 'stripe';
import { sendEmailNotification } from '@/lib/notifications';
import { purgeClosedAccount } from '@/lib/account-purge';
import { getWelcomeAppUrl } from '@/lib/welcome-onboarding';
import {
  buildExportEmail,
  buildWarningEmail,
  parseOffers,
  TRIAL_INACTIVITY_POLICY,
  type InactivityCandidate,
  type InactivityCycle,
} from '@/lib/trial-inactivity';
import { buildExportZip, type ExportedFile } from '@/lib/trial-inactivity-export';
import type { TrialInactivityDeps } from '@/lib/trial-inactivity-runner';

export const EXPORT_BUCKET = 'account-exports';
/** Attach the ZIP to the email when it is at most this big (Resend allows 40 MB total). */
const MAX_ATTACH_BYTES = 8 * 1024 * 1024;
const DAY_S = 24 * 60 * 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every object path under media/<userId>/ (recursive). */
export async function listUserMedia(admin: SupabaseClient, userId: string, max = 5000): Promise<string[]> {
  if (!UUID.test(userId)) throw new Error('not a user id');
  const bucket = admin.storage.from('media');
  const out: string[] = [];
  const folders = [userId];
  while (folders.length && out.length < max) {
    const folder = folders.pop() as string;
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await bucket.list(folder, { limit: 1000, offset, sortBy: { column: 'name', order: 'asc' } });
      if (error) throw new Error(`list ${folder}: ${error.message}`);
      for (const e of data || []) {
        const full = `${folder}/${e.name}`;
        if (!e.id) folders.push(full);
        else out.push(full);
      }
      if ((data || []).length < 1000) break;
    }
  }
  return out.slice(0, max);
}

async function selectAll(admin: SupabaseClient, table: string, column: string, userId: string) {
  const { data, error } = await admin.from(table).select('*').eq(column, userId).limit(10000);
  if (error) {
    // Optional tables (not every project has every add-on table) must not block the export.
    if (/does not exist|schema cache/i.test(error.message)) return [];
    throw new Error(`read ${table}: ${error.message}`);
  }
  return data || [];
}

export function buildTrialInactivityDeps(admin: SupabaseClient, stripe: Stripe | null): TrialInactivityDeps {
  const appUrl = getWelcomeAppUrl();
  const offers = parseOffers(process.env.TRIAL_INACTIVITY_OFFERS);

  return {
    now: () => new Date(),

    listCandidates: async () => {
      const { data, error } = await admin.rpc('trial_inactivity_candidates', {
        p_offers: offers,
        p_min_inactive_days: TRIAL_INACTIVITY_POLICY.warnAfterDays,
      });
      if (error) throw new Error(`candidates: ${error.message}`);
      return (data || []) as InactivityCandidate[];
    },

    listOpenCycles: async () => {
      const { data, error } = await admin
        .from('trial_inactivity_log')
        .select('*')
        .is('cleared_at', null)
        .is('deleted_at', null)
        .limit(1000);
      if (error) throw new Error(`log: ${error.message}`);
      return (data || []) as InactivityCycle[];
    },

    createCycle: async (userId, lastActiveAt) => {
      const { data, error } = await admin
        .from('trial_inactivity_log')
        .insert({ user_id: userId, last_active_at: lastActiveAt })
        .select('*')
        .single();
      if (error) throw new Error(`log insert: ${error.message}`);
      return data as InactivityCycle;
    },

    updateCycle: async (id, patch) => {
      const { error } = await admin
        .from('trial_inactivity_log')
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq('id', id);
      if (error) throw new Error(`log update: ${error.message}`);
    },

    confirmUnpaidTrial: async (c) => {
      if (!c.stripe_subscription_id && !c.stripe_customer_id) return { ok: true };
      if (!stripe) return { ok: false, reason: 'Stripe not configured; cannot confirm the trial is unpaid' };
      if (c.stripe_subscription_id) {
        const sub = await stripe.subscriptions.retrieve(c.stripe_subscription_id);
        if (sub.status !== 'trialing') return { ok: false, reason: `Stripe subscription is ${sub.status}` };
      }
      if (c.stripe_customer_id) {
        const paid = await stripe.invoices.list({ customer: c.stripe_customer_id, status: 'paid', limit: 20 });
        if (paid.data.some((inv) => (inv.amount_paid || 0) > 0)) return { ok: false, reason: 'customer has paid invoices' };
      }
      return { ok: true };
    },

    sendWarning: async (c, cycle, deleteAfter) => {
      const mail = buildWarningEmail({
        name: c.full_name,
        email: String(c.email),
        lastActiveAt: c.last_active_at,
        deleteAfter,
        signInUrl: `${appUrl}/login`,
      });
      return sendEmailNotification(String(c.email), mail.subject, mail.text, {
        html: mail.html,
        idempotencyKey: `trial-warning/${cycle.id}`,
      });
    },

    sendExport: async (c, cycle) => {
      const userId = c.user_id;
      if (!UUID.test(userId) || !UUID.test(cycle.id)) return { ok: false, error: 'bad id' };
      const prefix = `${cycle.id}`;
      const ttl = TRIAL_INACTIVITY_POLICY.exportLinkDays * DAY_S;
      const generatedAt = new Date();
      const expiresAt = new Date(generatedAt.getTime() + ttl * 1000).toISOString();
      const out = admin.storage.from(EXPORT_BUCKET);

      // 1. Copy every photo / file out of media/<uid>/ so the links survive the deletion.
      const media = await listUserMedia(admin, userId);
      const copied: string[] = [];
      for (const path of media) {
        const rel = path.slice(userId.length + 1);
        const dest = `${prefix}/files/${rel}`;
        const { error } = await admin.storage.from('media').copy(path, dest, { destinationBucket: EXPORT_BUCKET });
        if (error && !/exists|duplicate/i.test(error.message)) {
          return { ok: false, error: `copy ${rel}: ${error.message}` };
        }
        copied.push(dest);
      }
      const files: ExportedFile[] = [];
      for (let i = 0; i < copied.length; i += 500) {
        const chunk = copied.slice(i, i + 500);
        const { data, error } = await out.createSignedUrls(chunk, ttl, { download: true });
        if (error) return { ok: false, error: `sign files: ${error.message}` };
        for (const s of data || []) {
          if (!s.signedUrl || s.error || !s.path) return { ok: false, error: `sign ${s.path}: ${s.error || 'no url'}` };
          files.push({ path: s.path.slice(prefix.length + '/files/'.length), url: s.signedUrl });
        }
      }

      // 2. Data → ZIP (README + CSV + JSON + files list) in the export bucket.
      const [documents, archives, receipts, crew, callLog, blockedNumbers] = await Promise.all([
        selectAll(admin, 'estimates', 'user_id', userId),
        selectAll(admin, 'archive-est', 'user_id', userId),
        selectAll(admin, 'receipts', 'user_id', userId),
        selectAll(admin, 'crew_members', 'owner_user_id', userId),
        selectAll(admin, 'receptionist_call_finalizations', 'user_id', userId),
        selectAll(admin, 'receptionist_blocked_numbers', 'user_id', userId),
      ]);
      const zip = buildExportZip({ documents, archives, receipts, crew, callLog, blockedNumbers }, files, {
        email: String(c.email),
        generatedAt: generatedAt.toISOString(),
        expiresAt,
      });
      const bytes = new Uint8Array(await zip.arrayBuffer());
      const zipName = `estimateace-export-${generatedAt.toISOString().slice(0, 10)}.zip`;
      const zipPath = `${prefix}/${zipName}`;
      const up = await out.upload(zipPath, bytes, { contentType: 'application/zip', upsert: true });
      if (up.error) return { ok: false, error: `upload zip: ${up.error.message}` };
      const zipSigned = await out.createSignedUrl(zipPath, ttl, { download: zipName });
      if (zipSigned.error || !zipSigned.data?.signedUrl) return { ok: false, error: `sign zip: ${zipSigned.error?.message}` };

      let filesIndexUrl: string | null = null;
      if (files.length) {
        const { filesIndexHtml } = await import('@/lib/trial-inactivity-export');
        const idxPath = `${prefix}/files.html`;
        const idx = await out.upload(idxPath, new TextEncoder().encode(filesIndexHtml(files, expiresAt)), {
          contentType: 'text/html; charset=utf-8',
          upsert: true,
        });
        if (!idx.error) {
          const s = await out.createSignedUrl(idxPath, ttl);
          filesIndexUrl = s.data?.signedUrl || null;
        }
      }

      // 3. Email (attachment when small). Deletion only happens after this succeeds.
      const attach = bytes.byteLength <= MAX_ATTACH_BYTES;
      const mail = buildExportEmail({
        name: c.full_name,
        email: String(c.email),
        warningSentAt: String(cycle.warning_sent_at),
        zipUrl: zipSigned.data.signedUrl,
        filesIndexUrl,
        fileCount: files.length,
        expiresAt,
        zipAttached: attach,
        newTrialUrl: `${appUrl}/trial`,
      });
      const sent = await sendEmailNotification(String(c.email), mail.subject, mail.text, {
        html: mail.html,
        idempotencyKey: `trial-export/${cycle.id}`,
        attachments: attach
          ? [{ filename: zipName, content: Buffer.from(bytes).toString('base64'), contentType: 'application/zip' }]
          : undefined,
      });
      if (!sent.ok) return { ok: false, error: sent.error };
      return { ok: true, id: sent.id, prefix, expiresAt };
    },

    deleteAccount: (userId) => purgeClosedAccount(userId),

    purgeExpiredExports: async () => {
      const cutoff = new Date(Date.now() - DAY_S * 1000).toISOString();
      const { data, error } = await admin
        .from('trial_inactivity_log')
        .select('id, export_prefix')
        .not('export_prefix', 'is', null)
        .is('export_files_purged_at', null)
        .lte('export_expires_at', cutoff)
        .limit(20);
      if (error) throw new Error(error.message);
      let n = 0;
      for (const row of (data || []) as { id: string; export_prefix: string }[]) {
        if (!UUID.test(row.export_prefix)) continue;
        const paths: string[] = [];
        const folders = [row.export_prefix];
        while (folders.length) {
          const f = folders.pop() as string;
          const { data: items, error: le } = await admin.storage.from(EXPORT_BUCKET).list(f, { limit: 1000 });
          if (le) throw new Error(le.message);
          for (const it of items || []) (it.id ? paths : folders).push(`${f}/${it.name}`);
        }
        for (let i = 0; i < paths.length; i += 500) {
          const { error: re } = await admin.storage.from(EXPORT_BUCKET).remove(paths.slice(i, i + 500));
          if (re) throw new Error(re.message);
        }
        await admin
          .from('trial_inactivity_log')
          .update({ export_files_purged_at: new Date().toISOString() })
          .eq('id', row.id);
        n++;
      }
      return n;
    },
  };
}
