/**
 * Stripe disputes (chargebacks): record each dispute once and alert the right person.
 *
 *  - connect  (a contractor's client disputed a job payment on the contractor's
 *              connected account) → email the contractor (account owner).
 *  - platform (someone disputed an EstimateAce charge: plan, crew seat, add-on)
 *              → email + text the EstimateAce platform owner.
 *
 * Idempotent per dispute id: the row is upserted, and each alert ("opened" / "closed")
 * is claimed atomically in stripe_disputes before sending, so Stripe retries or
 * duplicate deliveries never send twice.
 */
import type Stripe from 'stripe';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { sendEmailNotification, sendSmsNotification } from '@/lib/notifications';
import { getOwnerAlertEmails, getOwnerAlertPhone } from '@/lib/owner-signup-alert';
import { rateLimit } from '@/lib/rate-limit';

export type DisputeScope = 'platform' | 'connect';
export const DISPUTE_EVENTS = new Set(['charge.dispute.created', 'charge.dispute.closed']);

type Admin = NonNullable<ReturnType<typeof getSupabaseAdmin>>;

function idOf(ref: unknown): string | null {
  if (!ref) return null;
  if (typeof ref === 'string') return ref;
  const id = (ref as { id?: unknown }).id;
  return typeof id === 'string' ? id : null;
}

function money(cents: number | null | undefined, currency?: string | null): string {
  const n = (Number(cents) || 0) / 100;
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: String(currency || 'usd').toUpperCase(),
    }).format(n);
  } catch {
    return `$${n.toFixed(2)}`;
  }
}

function etDate(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-US', {
    timeZone: 'America/New_York',
    dateStyle: 'medium',
    timeStyle: 'short',
  }) + ' ET';
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function reasonLabel(reason: string | null | undefined): string {
  const r = String(reason || '').replace(/_/g, ' ').trim();
  return r ? r.charAt(0).toUpperCase() + r.slice(1) : 'Not given';
}

async function claimMarker(admin: Admin, disputeId: string, column: 'opened_notified_at' | 'closed_notified_at') {
  const { data, error } = await admin
    .from('stripe_disputes')
    .update({ [column]: new Date().toISOString() })
    .eq('dispute_id', disputeId)
    .is(column, null)
    .select('dispute_id');
  if (error) throw new Error(`dispute marker: ${error.message}`);
  return Array.isArray(data) && data.length > 0;
}

async function releaseMarker(admin: Admin, disputeId: string, column: 'opened_notified_at' | 'closed_notified_at') {
  await admin.from('stripe_disputes').update({ [column]: null }).eq('dispute_id', disputeId);
}

async function ownerForConnectedAccount(admin: Admin, accountId: string | null): Promise<string | null> {
  if (!accountId) return null;
  const { data } = await admin
    .from('payment_accounts')
    .select('user_id')
    .eq('stripe_account_id', accountId)
    .maybeSingle();
  return (data as { user_id?: string } | null)?.user_id || null;
}

async function ownerEmail(admin: Admin, userId: string): Promise<string | null> {
  try {
    const { data } = await admin.auth.admin.getUserById(userId);
    const email = String(data?.user?.email || '').trim();
    if (email) return email;
  } catch {
    /* fall back to profile */
  }
  const { data: settings } = await admin
    .from('estimates')
    .select('profile')
    .eq('id', `SETTINGS-${userId}`)
    .maybeSingle();
  const email = String((settings?.profile as { email?: string } | null)?.email || '').trim();
  return email.includes('@') ? email : null;
}

type DisputeContext = {
  dispute: Stripe.Dispute;
  scope: DisputeScope;
  accountId: string | null;
  ownerUserId: string | null;
  documentId: string | null;
  customerEmail: string | null;
  description: string | null;
};

async function loadContext(
  stripe: Stripe,
  admin: Admin,
  event: Stripe.Event,
  scope: DisputeScope
): Promise<DisputeContext> {
  const dispute = event.data.object as Stripe.Dispute;
  const accountId = scope === 'connect' ? event.account || null : null;
  const reqOpts = accountId ? { stripeAccount: accountId } : undefined;
  let documentId: string | null = null;
  let customerEmail: string | null = null;
  let description: string | null = null;
  let metaOwner: string | null = null;

  const chargeId = idOf(dispute.charge);
  if (chargeId) {
    try {
      const charge = await stripe.charges.retrieve(chargeId, {}, reqOpts);
      customerEmail = charge.billing_details?.email || charge.receipt_email || null;
      description = charge.description || null;
      documentId = charge.metadata?.invoice_id || null;
      metaOwner = charge.metadata?.supabase_user_id || null;
    } catch (e) {
      console.warn('dispute: charge lookup failed', (e as Error)?.message);
    }
  }
  const piId = idOf(dispute.payment_intent);
  if (piId && (!documentId || !metaOwner)) {
    try {
      const pi = await stripe.paymentIntents.retrieve(piId, {}, reqOpts);
      documentId = documentId || pi.metadata?.invoice_id || null;
      metaOwner = metaOwner || pi.metadata?.supabase_user_id || null;
      description = description || pi.description || null;
    } catch (e) {
      console.warn('dispute: payment intent lookup failed', (e as Error)?.message);
    }
  }

  let ownerUserId: string | null = null;
  if (scope === 'connect') {
    // The connected account decides the owner; metadata is only a fallback.
    ownerUserId = (await ownerForConnectedAccount(admin, accountId)) || null;
    if (!ownerUserId && metaOwner) {
      const { data } = await admin
        .from('payment_accounts')
        .select('user_id, stripe_account_id')
        .eq('user_id', metaOwner)
        .maybeSingle();
      if (data && (data as { stripe_account_id?: string }).stripe_account_id === accountId) {
        ownerUserId = metaOwner;
      }
    }
  }

  return { dispute, scope, accountId, ownerUserId, documentId, customerEmail, description };
}

async function recordDispute(admin: Admin, ctx: DisputeContext, eventType: string) {
  const d = ctx.dispute;
  const dueBy = d.evidence_details?.due_by ? new Date(d.evidence_details.due_by * 1000).toISOString() : null;
  const row: Record<string, unknown> = {
    dispute_id: d.id,
    scope: ctx.scope,
    livemode: d.livemode,
    stripe_account_id: ctx.accountId,
    owner_user_id: ctx.ownerUserId,
    charge_id: idOf(d.charge),
    payment_intent_id: idOf(d.payment_intent),
    document_id: ctx.documentId,
    amount: d.amount,
    currency: d.currency,
    reason: d.reason,
    status: d.status,
    evidence_due_by: dueBy,
    created_at: d.created ? new Date(d.created * 1000).toISOString() : new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  if (eventType === 'charge.dispute.closed') row.closed_at = new Date().toISOString();
  const { error } = await admin.from('stripe_disputes').upsert(row, { onConflict: 'dispute_id' });
  if (error) throw new Error(`dispute record: ${error.message}`);
}

function buildMessage(ctx: DisputeContext, kind: 'opened' | 'closed') {
  const d = ctx.dispute;
  const amount = money(d.amount, d.currency);
  const due = d.evidence_details?.due_by ? etDate(new Date(d.evidence_details.due_by * 1000).toISOString()) : '';
  const forWhat = ctx.documentId ? ` on ${ctx.documentId}` : '';
  const outcome = d.status === 'won' ? 'won' : d.status === 'lost' ? 'lost' : String(d.status || 'closed').replace(/_/g, ' ');
  const isPlatform = ctx.scope === 'platform';

  const subject =
    kind === 'opened'
      ? `${isPlatform ? 'EstimateAce charge disputed' : 'A client disputed a payment'}: ${amount}${forWhat}`
      : `Dispute ${outcome}: ${amount}${forWhat}`;

  const lines = [
    kind === 'opened'
      ? isPlatform
        ? 'A customer disputed a payment to EstimateAce (subscription, crew seat or add-on).'
        : 'One of your clients opened a dispute (chargeback) on a card payment you received through EstimateAce.'
      : `A payment dispute was closed. Result: ${outcome}.`,
    '',
    `Amount: ${amount}`,
    `Reason: ${reasonLabel(d.reason)}`,
    ctx.documentId ? `Document: ${ctx.documentId}` : '',
    ctx.description ? `Payment: ${ctx.description}` : '',
    ctx.customerEmail ? `Customer: ${ctx.customerEmail}` : '',
    kind === 'opened' && due ? `Respond by: ${due}` : '',
    `Stripe dispute ID: ${d.id}`,
    '',
    kind === 'opened'
      ? isPlatform
        ? 'Respond in the Stripe Dashboard → Payments → Disputes before the deadline.'
        : 'Respond before the deadline: in EstimateAce open Profile → Payments → Stripe dashboard, then Disputes. Upload the signed estimate, invoice, photos and any messages that show the work was done.'
      : '',
  ].filter((l, i, arr) => l !== '' || (i > 0 && arr[i - 1] !== ''));

  const text = lines.join('\n').trim();
  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;line-height:1.5;color:#0f172a">${lines
    .map((l) => (l ? `<p style="margin:4px 0">${escapeHtml(l)}</p>` : '<br/>'))
    .join('')}</div>`;
  const sms = `EstimateAce: ${kind === 'opened' ? 'dispute opened' : `dispute ${outcome}`} ${amount}${
    due && kind === 'opened' ? `, respond by ${due}` : ''
  } (${d.id})`.slice(0, 320);
  return { subject: subject.slice(0, 180), text, html, sms };
}

async function notify(admin: Admin, ctx: DisputeContext, kind: 'opened' | 'closed'): Promise<boolean> {
  const msg = buildMessage(ctx, kind);
  let delivered = false;
  if (ctx.scope === 'platform') {
    for (const to of getOwnerAlertEmails()) {
      const r = await sendEmailNotification(to, msg.subject, msg.text, { html: msg.html });
      if (r.ok) delivered = true;
      else console.warn('dispute alert email failed:', r.error);
    }
    if (kind === 'opened') {
      const sms = await sendSmsNotification(getOwnerAlertPhone(), msg.sms, { skipOptInCheck: true });
      if (sms.ok) delivered = true;
      else console.warn('dispute alert sms failed:', sms.error);
    }
    return delivered;
  }
  if (!ctx.ownerUserId) {
    console.warn('dispute: no EstimateAce owner for connected account', ctx.accountId, ctx.dispute.id);
    return true; // nothing to send to; recorded for follow-up
  }
  const to = await ownerEmail(admin, ctx.ownerUserId);
  if (!to) {
    console.warn('dispute: owner has no email', ctx.ownerUserId, ctx.dispute.id);
    return true;
  }
  const r = await sendEmailNotification(to, msg.subject, msg.text, { html: msg.html });
  if (!r.ok) console.warn('dispute owner email failed:', r.error);
  return r.ok;
}

/**
 * Handle charge.dispute.created / charge.dispute.closed. Throws on infrastructure
 * errors so the webhook returns 500 and Stripe retries (safe: everything is idempotent).
 */
export async function handleDisputeEvent(
  stripe: Stripe,
  event: Stripe.Event,
  scope: DisputeScope
): Promise<void> {
  if (!DISPUTE_EVENTS.has(event.type)) return;
  const admin = getSupabaseAdmin();
  if (!admin) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY');

  const ctx = await loadContext(stripe, admin, event, scope);
  await recordDispute(admin, ctx, event.type);

  const kind = event.type === 'charge.dispute.created' ? 'opened' : 'closed';
  const column = kind === 'opened' ? 'opened_notified_at' : 'closed_notified_at';
  if (!(await claimMarker(admin, ctx.dispute.id, column))) return; // already alerted

  // Global backstop so a flood of disputes can never spam inboxes / phones.
  const flood = await rateLimit('dispute-alert:global', 24 * 60 * 60, 200);
  if (!flood.allowed) {
    console.warn('dispute alerts paused (daily cap)', ctx.dispute.id);
    return;
  }

  const delivered = await notify(admin, ctx, kind);
  if (!delivered) {
    // Nothing went out: release the claim so Stripe's retry can try again.
    await releaseMarker(admin, ctx.dispute.id, column);
    throw new Error(`dispute ${ctx.dispute.id}: alert not delivered`);
  }
}
