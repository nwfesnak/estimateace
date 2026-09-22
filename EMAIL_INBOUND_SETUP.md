# Email lead summaries — forward from any provider

## How it works

Saving **Your business inbox** on Profile only stores which mailbox you use.  
Summaries appear on the dashboard when mail is **forwarded** to each user’s unique EstimateAce address.

**Not limited to Google/Microsoft** — Gmail, Outlook, Yahoo, Apple, Zoho, cPanel, Google Workspace, Microsoft 365, etc. all work via auto-forward / filter-forward.

## User flow

1. Profile → Company Info → enter business inbox (label only).
2. Copy **Forward leads to this EstimateAce address** (`u{32hex}@inbound.estimateace.com`).
3. In their email provider, forward lead mail to that address.
4. Dashboard → Email summaries updates about once an hour (or Refresh now). Delete removes the summary only (not the original inbox email).

## Ops (inbound receiving)

1. Ensure `inbound.estimateace.com` MX receives mail and delivers to your inbound provider.
2. Webhook that posts into EstimateAce: `https://app.estimateace.com/api/webhooks/resend/inbound`  
   (or equivalent if using another provider that can POST the same payload shape).
3. Vercel env:
   - `EMAIL_INBOUND_DOMAIN=inbound.estimateace.com`
   - `NEXT_PUBLIC_EMAIL_INBOUND_DOMAIN=inbound.estimateace.com`
   - `RESEND_API_KEY` (if using Resend receiving.get for body text)
   - Optional: `RESEND_WEBHOOK_SECRET=...`

## API

| Route | Purpose |
|-------|---------|
| `POST /api/webhooks/resend/inbound` | Inbound `email.received` → Grok summary → SETTINGS |
