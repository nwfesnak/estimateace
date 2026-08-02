import { NextRequest, NextResponse } from 'next/server';
import type Stripe from 'stripe';
import { getStripe } from '@/lib/stripe-server';
import { upsertSubscriptionFromStripe } from '@/lib/billing-sync';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const stripe = getStripe();
  const secret = (process.env.STRIPE_WEBHOOK_SECRET || '').trim();
  if (!stripe || !secret) {
    return NextResponse.json({ error: 'Webhook not configured' }, { status: 503 });
  }

  const body = await request.text();
  const sig = request.headers.get('stripe-signature');
  if (!sig) {
    return NextResponse.json({ error: 'Missing signature' }, { status: 400 });
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, secret);
  } catch (err: any) {
    console.error('webhook signature:', err?.message);
    return NextResponse.json({ error: `Webhook Error: ${err?.message}` }, { status: 400 });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        const userId = (session.client_reference_id ||
          session.metadata?.supabase_user_id) as string | undefined;
        if (session.subscription) {
          const subId =
            typeof session.subscription === 'string'
              ? session.subscription
              : session.subscription.id;
          const sub = await stripe.subscriptions.retrieve(subId);
          const result = await upsertSubscriptionFromStripe(sub, userId || null);
          if (!result.ok) console.error('webhook checkout upsert:', result.error);
        }
        break;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription;
        const result = await upsertSubscriptionFromStripe(sub);
        if (!result.ok) console.error('webhook sub upsert:', result.error);
        break;
      }
      case 'invoice.paid':
      case 'invoice.payment_failed':
      case 'invoice.finalized': {
        const invoice = event.data.object as Stripe.Invoice;
        const subRef = (invoice as any).subscription;
        if (!subRef) break;
        const subId = typeof subRef === 'string' ? subRef : subRef.id;
        const sub = await stripe.subscriptions.retrieve(subId);
        const result = await upsertSubscriptionFromStripe(sub);
        if (!result.ok) console.error('webhook invoice upsert:', result.error);
        break;
      }
      default:
        break;
    }
  } catch (e) {
    console.error('webhook handler:', e);
    return NextResponse.json({ error: 'Handler failed' }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
