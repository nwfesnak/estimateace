# Email lead summaries — forward from any provider

## Honest status

Saving **Your business inbox** on Profile only stores which mailbox you use.  
Summaries appear on the dashboard when mail is **forwarded** to each user’s unique EstimateAce address (or via **Add test summary**).

**Not limited to Google/Microsoft** — Gmail, Outlook, Yahoo, Apple, Zoho, cPanel, Google Workspace, Microsoft 365, etc. all work via auto-forward / filter-forward.

## User flow

1. Profile → Company Info → enter business inbox (label only).
2. Copy **Forward leads to this EstimateAce address** (`u{32hex}@inbound.estimateace.com`).
3. In their email provider, forward lead mail to that address.
4. Dashboard → Email summaries updates about once an hour (or Refresh now).

## Ops (Resend inbound)

1. In Resend: verify domain `inbound.estimateace.com` (or your choice) and **enable Receiving / Inbound**.
2. MX records must point at Resend for that domain.
3. Webhook URL: `https://app.estimateace.com/api/webhooks/resend/inbound`  
   Event: `email.received`
4. Vercel env:
   - `RESEND_API_KEY` (already used for outbound)
   - `EMAIL_INBOUND_DOMAIN=inbound.estimateace.com`
   - `NEXT_PUBLIC_EMAIL_INBOUND_DOMAIN=inbound.estimateace.com`
   - Optional: `RESEND_WEBHOOK_SECRET=...` (also pass `?secret=` or matching header)

Until MX/webhook are live, users can still click **Add test summary** to see the dashboard box fill in.

## API

| Route | Purpose |
|-------|---------|
| `POST /api/webhooks/resend/inbound` | Resend `email.received` → Grok summary → SETTINGS |
| `POST /api/email-leads/ingest` | Auth’d test/manual summary (`{ test: true }`) |
| `GET /api/email-leads/ingest` | Returns this user’s forward address |
