# AI Receptionist add-on — $49.99/month (Stripe)

Users must **Confirm & pay** before they can enable a Twilio AI line.

## App flow

1. **Phone line** → **Confirm & pay $49.99/mo** → Stripe Checkout  
2. Webhook sets `receptionistBilling` + `aiReceptionistAddonActive`  
3. Return to app → **Enable AI receptionist line** (buys Twilio number)

## Stripe Dashboard (Live)

1. Product: **EstimateAce AI Receptionist**  
2. Recurring price: **$49.99 USD / month**  
3. Copy Price ID → Vercel:

```
STRIPE_PRICE_ID_RECEPTIONIST_ADDON=price_...
```

If the env var is missing, checkout still works with inline `price_data` at $49.99.

## Webhook

Same endpoint as SaaS: `/api/billing/webhook`  
Metadata: `purpose=receptionist_addon` (does not overwrite main plan).

## Required env

- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `SUPABASE_SERVICE_ROLE_KEY`
- Twilio master vars (for step 3 provision)
