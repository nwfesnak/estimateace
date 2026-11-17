import { NextRequest, NextResponse } from 'next/server';
import type Stripe from 'stripe';
import { getStripe } from '@/lib/stripe-server';
import {
  markDocumentPaidFromJobCheckout,
  updatePaymentAccountFromStripe,
} from '@/lib/job-payments';
import {
  getRecurringPlan,
  markRecurringActiveFromCheckout,
  updateRecurringPlan,
} from '@/lib/recurring-services';

export const runtime = 'nodejs';

/**
 * Stripe Connect webhook — events that happen ON contractors' connected accounts.
 *
 * In Stripe: Developers → Webhooks → Add endpoint → "Events on Connected accounts"
 *   URL: https://app.estimateace.com/api/payments/connect/webhook
 *   Events: account.updated, checkout.session.completed,
 *           checkout.session.async_payment_succeeded, invoice.paid,
 *           invoice.payment_failed, customer.subscription.updated,
 *           customer.subscription.deleted
 * Signing secret → STRIPE_CONNECT_WEBHOOK_SECRET (separate from STRIPE_WEBHOOK_SECRET).
 *
 * EstimateAce's own subscriptions (plans, crew seats, receptionist) stay on
 * /api/billing/webhook. Every handler here is safe to receive more than once.
 */
export async function POST(request: NextRequest) {
  const stripe = getStripe();
  const secret = (process.env.STRIPE_CONNECT_WEBHOOK_SECRET || '').trim();
  if (!stripe || !secret) {
    return NextResponse.json({ error: 'Connect webhook not configured' }, { status: 503 });
  }

  const body = await request.text();
  const sig = request.headers.get('stripe-signature');
  if (!sig) {
    return NextResponse.json({ error: 'Missing signature' }, { status: 400 });
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, secret);
  } catch (err: unknown) {
    console.error('connect webhook signature:', (err as Error)?.message);
    return NextResponse.json({ error: `Webhook Error: ${(err as Error)?.message}` }, { status: 400 });
  }

  const connectedAccount = event.account || null;
  const reqOpts: Stripe.RequestOptions | undefined = connectedAccount
    ? { stripeAccount: connectedAccount }
    : undefined;

  try {
    switch (event.type) {
      case 'account.updated': {
        const acct = event.data.object as Stripe.Account;
        const result = await updatePaymentAccountFromStripe(acct);
        if (!result.ok) console.error('connect webhook account.updated:', result.error);
        else if (!result.matched) console.warn('connect webhook: no payment_accounts row for', acct.id);
        break;
      }

      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded': {
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.metadata?.purpose === 'job_payment') {
          // ACH: completed fires with payment_status "unpaid"; the async_payment_succeeded
          // event marks it paid later.
          if (session.payment_status !== 'paid') break;
          const r = await markDocumentPaidFromJobCheckout(session, {
            stripeAccount: connectedAccount,
          });
          if (!r.ok) console.error('connect webhook job payment:', r.error);
          break;
        }
        if (
          session.metadata?.purpose === 'client_recurring_subscription' &&
          event.type === 'checkout.session.completed'
        ) {
          const r = await markRecurringActiveFromCheckout(session);
          if (!r.ok) console.error('connect webhook client recurring:', r.error);
        }
        break;
      }

      case 'invoice.paid':
      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        const subId = invoiceSubscriptionId(invoice);
        if (!subId) break;
        const sub = await stripe.subscriptions.retrieve(subId, undefined, reqOpts);
        const ids = recurringIds(sub);
        if (!ids) break;
        if (event.type === 'invoice.paid') {
          const paidAt = invoice.status_transitions?.paid_at
            ? new Date(invoice.status_transitions.paid_at * 1000).toISOString()
            : new Date().toISOString();
          const r = await updateRecurringPlan(ids.ownerId, ids.planId, {
            lastPaymentAt: paidAt,
            stripeSubscriptionId: sub.id,
          });
          if (!r.ok) console.error('connect webhook recurring invoice.paid:', r.error);
        } else {
          console.warn('connect webhook: client recurring payment failed', ids.planId, invoice.id);
        }
        break;
      }

      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription;
        const ids = recurringIds(sub);
        if (!ids) break;
        if (event.type === 'customer.subscription.deleted' || sub.status === 'canceled') {
          const plan = await getRecurringPlan(ids.ownerId, ids.planId);
          if (plan && plan.status !== 'canceled') {
            const r = await updateRecurringPlan(ids.ownerId, ids.planId, {
              status: 'canceled',
              stripeSubscriptionId: null,
            });
            if (!r.ok) console.error('connect webhook recurring canceled:', r.error);
          }
        }
        break;
      }

      default:
        break;
    }
  } catch (e) {
    console.error('connect webhook handler:', e);
    // 500 so Stripe retries; handlers are idempotent.
    return NextResponse.json({ error: 'Handler failed' }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}

function invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  // Older API versions: invoice.subscription. Newer: invoice.parent.subscription_details.subscription.
  const inv = invoice as unknown as {
    subscription?: string | { id: string } | null;
    parent?: { subscription_details?: { subscription?: string | { id: string } | null } | null } | null;
  };
  const ref = inv.subscription ?? inv.parent?.subscription_details?.subscription ?? null;
  if (!ref) return null;
  return typeof ref === 'string' ? ref : ref.id || null;
}

function recurringIds(sub: Stripe.Subscription): { ownerId: string; planId: string } | null {
  if (sub.metadata?.purpose !== 'client_recurring_subscription') return null;
  const ownerId = String(sub.metadata?.supabase_user_id || '').trim();
  const planId = String(sub.metadata?.recurring_plan_id || '').trim();
  if (!ownerId || !planId) return null;
  return { ownerId, planId };
}
