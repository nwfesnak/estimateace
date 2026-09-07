# One Twilio number for all EstimateAce SMS

AI Receptionist stays separate (third party later). This guide covers **text reminders and transactional SMS** only.

## How it works (already in the app)

- EstimateAce uses **one** platform Twilio number (`TWILIO_PHONE_NUMBER`) for every account.
- Daily cron (`/api/cron/appointment-reminders` at 8:00 AM Eastern / 13:00 UTC) texts each contractor who:
  1. Turned **Appointment reminders** on
  2. Turned **Opt in to text messaging** on
  3. Has **company phone** + **company email** on Profile
  4. Has appointments on the calendar for **tomorrow**
- Client texts (estimate/invoice send, appointment notify) also send **From** that same number.
- You do **not** buy a Twilio number per contractor for SMS.

## Your next steps (ops — do these in order)

### 1. Unsuspend / fund Twilio (if needed)
- Console → account status + billing balance above $0.

### 2. Finish A2P so Error **30034** stops
In Twilio Console:
1. **Messaging → Services** → open (or create) a Messaging Service linked to your **approved A2P Campaign**.
2. **Sender Pool** → add your one number (`+1…`) — must show registered, not Unregistered.
3. Sole Proprietor campaigns: **only one** 10DLC number allowed.
4. Copy the Messaging Service SID (`MG…`).

### 3. Wire Vercel env (Production) and redeploy
```
TWILIO_ACCOUNT_SID=AC…
TWILIO_AUTH_TOKEN=…
TWILIO_PHONE_NUMBER=+1XXXXXXXXXX
TWILIO_MESSAGING_SERVICE_SID=MG…   ← important for A2P
NEXT_PUBLIC_SMS_OPT_IN_NUMBER=+1XXXXXXXXXX
CRON_SECRET=long-random-string
SUPABASE_SERVICE_ROLE_KEY=…
```
Confirm Vercel Cron is enabled for the project (`vercel.json` already schedules the reminders path).

### 4. Twilio webhook for STOP/HELP
Phone number → Messaging → “A message comes in”:
`https://app.estimateace.com/api/sms/inbound`

### 5. Smoke test per account
1. Profile → set company phone/email  
2. Enable **Appointment reminders** + **SMS opt-in**  
3. **Test Reminder Now**  
4. Twilio → Monitor → Logs: status should be **delivered** (not 30034)

### 6. Client texts
When sending estimates/invoices by SMS or notifying a client of an appointment, recipients must be able to reply **STOP**. Prefer people who opted in. Same single From number.

## What one number covers today
| Feature | Uses shared Twilio # |
|--------|----------------------|
| Contractor calendar reminders (cron + test) | Yes |
| Estimate / invoice SMS send | Yes |
| Appointment notify to client | Yes |
| Login OTP / 2FA SMS | Yes |
| SMS opt-in / STOP webhook | Yes |
| AI Receptionist live voice | **No** — third party later |

## Common failures
| Symptom | Fix |
|---------|-----|
| Error 30034 | Number not in approved Campaign / Messaging Service sender pool |
| Trial / 21608 | Upgrade off Trial or verify destination numbers |
| Cron never fires | Vercel Cron + `CRON_SECRET` + service role key |
| “SMS opt-in off” | Profile toggle |
| No appointments tomorrow | Add calendar jobs or use Test Reminder Now |
