# Auto welcome email + text on signup (no CRM)

When someone finishes **Start free trial** on `/trial`, EstimateAce can automatically send:

1. **Email** (Resend) with your walkthrough video link  
2. **SMS** (Twilio) with the same link  

No CRM. Uses the email/phone they enter at signup.

---

## 1) Put your video somewhere shareable

Upload to **YouTube (Unlisted)**, **Loom**, or **Vimeo**, then copy the share URL.

Example:
```
https://www.youtube.com/watch?v=xxxxxxxxxxx
```

---

## 2) Vercel env (Production)

| Name | Value |
|------|--------|
| `WELCOME_VIDEO_URL` | your video share link |
| `RESEND_API_KEY` | already used for app emails |
| `NOTIFICATION_FROM_EMAIL` | e.g. `EstimateAce <notifications@estimateace.com>` |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / phone or Messaging Service | already used for SMS |

Redeploy after saving `WELCOME_VIDEO_URL`.

If `WELCOME_VIDEO_URL` is missing, signup still works — welcome email/SMS are skipped (logged on server).

---

## 3) What the user gets

**SMS (short):**  
Hi {name} — welcome to EstimateAce! Watch this quick walkthrough: {link} Then log in at app.estimateace.com … Reply STOP to opt out.

**Email:**  
Welcome + “Watch the walkthrough” button + app login link + Add to Home Screen tip.

---

## 4) Sent only once — only on landing-page signup

Sent **only** from `/api/billing/start-trial` (trial / 2mo / 6mo landing signups).

**Not** sent on normal login or billing status checks.

Stored on their settings profile as `welcomeOnboardingSentAt` (preserved across company profile saves).

---

## 5) Test

1. Set `WELCOME_VIDEO_URL` → redeploy  
2. Sign up a **new** test account on `/trial` with a real email + phone you control  
3. Confirm email + text arrive with the video link  

Already-tested accounts that already have `welcomeOnboardingSentAt` will not get another send.
