# Phase A — Soft sell (in progress)

Goal: ship EstimateAce as a **real multi-customer product** for estimating/invoicing, with honest labels on unfinished extras.

## Implemented in code

- [x] Stripe Checkout + Customer Portal + webhook APIs
- [x] `subscriptions` table SQL + access gate component
- [x] Free trial clock (default 14 days) when billing status is seeded
- [x] Terms (`/terms`) + Privacy (`/privacy`)
- [x] Support email (`NEXT_PUBLIC_SUPPORT_EMAIL`)
- [x] Crew fake $20 flow removed (beta free seats + Phase B note)
- [x] AI Receptionist labeled **beta / test call only** (no live phone claim in UI)
- [x] 2FA already disabled in code

## You must configure (ops)

1. **Production Supabase**
   - Run `supabase/schema.sql`, `rls-policies.sql`, `storage-policies.sql`
   - Run `supabase/subscriptions.sql`
   - Private `media` bucket
   - Test: two users cannot read each other’s rows

2. **Vercel env (Production)**
   ```
   NEXT_PUBLIC_SUPABASE_URL=
   NEXT_PUBLIC_SUPABASE_ANON_KEY=
   SUPABASE_SERVICE_ROLE_KEY=          # required for billing webhook + trial seed
   GROK_API_KEY=

   # Billing (Phase A)
   STRIPE_SECRET_KEY=
   STRIPE_PRICE_ID=                    # recurring Price ID from Stripe Dashboard
   STRIPE_WEBHOOK_SECRET=              # from Stripe webhook endpoint
   NEXT_PUBLIC_BILLING_ENFORCE=false   # set true only when ready to hard-paywall
   NEXT_PUBLIC_TRIAL_DAYS=14
   NEXT_PUBLIC_APP_URL=https://app.estimateace.com
   NEXT_PUBLIC_SUPPORT_EMAIL=support@estimateace.com
   ```

3. **Stripe Dashboard**
   - Create Product + recurring Price → copy Price ID
   - Webhook endpoint: `https://app.estimateace.com/api/billing/webhook`
   - Events: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`
   - Customer Portal: enable subscription cancel/update

4. **Soft launch recommendation**
   - Keep `NEXT_PUBLIC_BILLING_ENFORCE=false` until Stripe + webhook tested end-to-end
   - Then set `true` and redeploy

5. **Smoke test**
   - Signup → trial status appears
   - Checkout test card `4242…` → webhook → status `active`
   - Portal opens
   - With enforce=true, expired trial sees paywall

## Still Phase B+

- Real crew invites (Supabase Auth) + seat billing
- Real MFA
- AI Receptionist live Twilio voice + forward-to number
- Stripe Connect for client job payments
