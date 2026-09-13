# AI Receptionist Option B — Phase 1 (shipped)

Per-contractor Twilio line: subaccount + local number + config APIs + UI.

## What works now

| Piece | Status |
|--------|--------|
| `POST /api/receptionist/enable` | Creates Twilio subaccount, buys US local number, sets webhooks |
| `GET /api/receptionist` | Public config + phone number (no secrets) |
| `PATCH /api/receptionist` | Branding, hours, transfer, enabled |
| `POST /api/receptionist/disable` | Soft-disable or release number |
| `GET /api/receptionist/usage` | Stub zeros (metering later) |
| Voice/SMS webhooks | Resolve tenant by `To` number; basic Say / SMS reply + inbox lead |
| UI | **AI Receptionist → Phone line** — Enable + show “Your AI line: +1…” |

## Not yet (Phase 2+)

- Live Media Stream / ConversationRelay AI conversation
- Agent tools: `createLead`, `transferHuman`, `scheduleCallback`
- Number porting API
- Real usage metering / Stripe add-on checkout for receptionist

## Env (Vercel Production)

```
TWILIO_ACCOUNT_SID=...          # master account
TWILIO_AUTH_TOKEN=...
NEXT_PUBLIC_APP_URL=https://app.estimateace.com
TWILIO_RECEPTIONIST_AREA_CODE=305   # optional default area code
SUPABASE_SERVICE_ROLE_KEY=...
```

Master Twilio account must allow **subaccounts** and **Incoming Phone Numbers** purchase.

## Secrets

Subaccount auth tokens are stored in `RECEPTIONIST-SECRETS-{userId}` (server-only).  
Public config is on `SETTINGS-{userId}.profile.receptionistConfig`.

## Test

1. Deploy with Twilio master creds  
2. Open AI Receptionist → **Phone line** → **Enable**  
3. Note the +1 number  
4. Call it — should hear Phase 1 greeting  
5. Text it — reply + Inbox message  
