# Stripe Connect: contractor payments

EstimateAce keeps two kinds of money apart:

| Money | Where it lands | Code |
| --- | --- | --- |
| EstimateAce plans, crew seats, AI Receptionist add-on | EstimateAce's own Stripe account (the platform) | `app/api/billing/*`, `app/api/crew/seat-checkout`, `app/api/receptionist/checkout` → webhook `/api/billing/webhook` |
| A contractor's customer paying an estimate deposit, invoice, or recurring plan | The contractor's own connected Stripe account (Express, direct charge) | `lib/job-payments.ts`, `lib/recurring-services.ts` → webhook `/api/payments/connect/webhook` |

There is **no platform fallback**. If a contractor has not finished Stripe Connect, card/bank
payments through Stripe are hidden on the client pay page and the API returns
`code: card_payments_not_set_up`. Venmo, PayPal, Zelle and mail check still work.

## Contractor flow

1. Profile → Payments → **Connect Stripe** (`POST /api/payments/connect/onboard`).
   Creates one connected account per workspace owner with controller properties (Express
   dashboard, Stripe-hosted onboarding, Stripe owns losses, contractor pays Stripe fees; see
   `lib/connect-account-params.ts`) — reused on retry; recreated if the stored id
   no longer exists in Stripe, e.g. test vs live key). Crew members cannot connect.
2. Stripe onboarding (identity, business, bank account for payouts).
   Return → `/?stripe_connect=return` (app re-checks status). Expired link →
   `/?stripe_connect=refresh` (app makes a fresh link automatically).
3. Status: `account.updated` on the Connect webhook updates `payment_accounts`. The status
   endpoint and checkout also re-check Stripe live whenever the stored flags say "not ready".
4. When ready, the button changes to **Stripe dashboard** (`POST /api/payments/connect/dashboard`,
   Express login link) for payouts and bank changes.
5. Payouts go to the contractor's bank on Stripe's default schedule. EstimateAce takes no
   application fee on job payments.

## Stripe Dashboard setup (live mode, EstimateAce account)

- Connect enabled; platform profile / questionnaire complete.
- Connect branding set (business name, icon, color) — required before live Express onboarding links work.
- Losses: new accounts use `controller.losses.payments = stripe` (Stripe Managed Risk), because
  Stripe rejects legacy `type: express` when the platform is the losses collector. Refunds and
  disputes are still taken from the contractor's balance first. Requires direct charges (we use
  them) and Radar for connected accounts.
- Settings → Payment methods → **connected accounts**: Cards and US bank account (ACH) on.
- Webhooks → Add endpoint → **Events on Connected accounts**:
  `https://app.estimateace.com/api/payments/connect/webhook` with
  `account.updated`, `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
  `invoice.paid`, `invoice.payment_failed`, `customer.subscription.updated`,
  `customer.subscription.deleted`.
  Put its signing secret in Vercel as `STRIPE_CONNECT_WEBHOOK_SECRET` and redeploy.
- The platform account's own identity and bank verification complete (for EstimateAce's payouts).
