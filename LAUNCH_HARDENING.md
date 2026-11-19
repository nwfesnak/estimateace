# Launch hardening (Nov 2026)

What this change does and the steps that must happen after it merges.

## After merge — required
1. **Vercel → estimateace → Settings → Environment Variables (Production):**
   - `NEXT_PUBLIC_BILLING_ENFORCE=true` → redeploy. Without it nothing is paywalled.
   - `RESEND_WEBHOOK_SECRET=whsec_...` from Resend → Webhooks → inbound webhook → Signing secret.
   - Optional: `STRIPE_PORTAL_CONFIGURATION_ID=bpc_1UdG0bAiPEmDowjcFP9QK3Ip` (already the account default).
2. **Supabase SQL Editor:** run `supabase/launch-hardening-2026-11.sql`.
3. **Supabase → Authentication → URL Configuration:** make sure
   `https://app.estimateace.com/reset-password` is allowed (or `https://app.estimateace.com/**`).
4. **Supabase → Authentication → Providers → Email:** turn on *Leaked password protection*
   (HaveIBeenPwned check; Pro plan feature).

## Behavior
- **Trials:** `trialing` only grants access until `trial_ends_at`. App-managed trials (no Stripe
  subscription) are blocked after that; Stripe-managed trials (subscribed mid-trial) get a 2-day
  grace for webhook lag. `past_due` is blocked. Crew inherit the owner's access.
- **API routes** (`lib/billing-access.ts → enforceAppAccess`) return `402 subscription_required`
  for the same cases: AI quote/grok/translate/receipts/job-render, documents save/send/terms-link,
  recurring, job checkout, appointments, crew invite/seat checkout, receptionist checkout/enable,
  Connect onboarding. Billing routes, support and webhooks stay open so people can subscribe.
- **Subscribe mid-trial:** Checkout passes `subscription_data.trial_end` = remaining trial
  (when ≥ ~49h away — Stripe's 48h minimum), so the first charge happens when the trial ends.
- **Trial lengths:** only standard (`NEXT_PUBLIC_TRIAL_DAYS`, default 14), `2mo` (60),
  `6mo` (180, card-free, first 20 signups). Standard and `2mo` require a card in Stripe
  Checkout. Retired `3mo` links get the standard trial. Unknown promos / mismatched
  `trialDays` → 400.
- **Password reset:** email links to `/reset-password` (set-new-password screen). Old links that
  land on `/` are redirected there on `PASSWORD_RECOVERY`.
- **Crew seats:** invite creates the login **disabled** (`seat_status=pending_payment`, Supabase
  ban). The crew-seat Stripe webhook enables it when the seat is active and disables it again when
  the seat fully ends. RLS `is_crew_of` also requires a paid seat (migration above).
- **Resend inbound:** Svix signature verification with `RESEND_WEBHOOK_SECRET`.
- **Billing portal:** default portal configuration created in Stripe live (cancel at period end,
  update card, invoices, monthly↔yearly). Route handles stale customers / missing config.
- **Terms:** operator, subscription/trial, cancellation & refunds, Stripe Connect payments section.
