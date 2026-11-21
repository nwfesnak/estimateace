# Privacy answers: Apple "App Privacy" label and Google Play "Data safety"

These answers match what the app does today. Re-check them if you add analytics, ads or push notifications.

## Basics
- **Tracking (Apple): No.** The Meta pixel is not loaded inside the app, and no data is shared with data brokers or used for ads in other apps. So: no App Tracking Transparency prompt.
- **Data sold: No. Data shared with third parties for their own use: No.** Processors (Supabase hosting, Stripe payments, Twilio calls/SMS, Resend email, the AI provider) act on our behalf. Both stores treat that as "not shared".
- **Encrypted in transit: Yes** (HTTPS only).
- **Users can request deletion: Yes.** In the app, and at https://app.estimateace.com/delete-account.

## Data collected (all **linked to the user**, all used for **App functionality**; none for tracking or ads)

| Apple category | Google Play category | What it is |
|---|---|---|
| Contact Info → Name | Personal info → Name | Account / company owner name, customer names entered by the contractor |
| Contact Info → Email Address | Personal info → Email address | Login email, customer emails |
| Contact Info → Phone Number | Personal info → Phone number | Business phone, customer phones, AI Receptionist callers |
| Contact Info → Physical Address | Personal info → Address | Business address, job-site addresses |
| User Content → Photos or Videos | Photos and videos | Job-site photos and walkthrough videos attached to estimates |
| User Content → Audio Data | Audio → Voice or sound recordings | Video sound; AI Receptionist call recordings/transcripts |
| User Content → Customer Support | App activity → Other user-generated content | Messages sent with "Message EstimateAce" |
| User Content → Other User Content | App activity → Other user-generated content | Estimates, invoices, notes, receipts |
| Identifiers → User ID | Personal info → User IDs | Account ID |
| Location → Coarse Location | Location → Approximate location | Used only to bias address autocomplete when you type a job-site or customer address (optional; you can refuse the system prompt and still type the address). Not used for tracking or ads. |
| Purchases → Purchase History | Financial info → Purchase history | Invoice and payment status for the contractor's own customers (card numbers are handled by Stripe and never stored by EstimateAce) |

**Not collected:** precise location (the app requests approximate location only, with `enableHighAccuracy: false`), contacts / address book, health, browsing history, search history, device ID for ads, crash/performance analytics (none in the app today), payment card numbers (Stripe holds them).

## Apple-specific
- "Data Used to Track You": **None**.
- "Data Linked to You": everything in the table above.
- "Data Not Linked to You": **None**.

## Google-specific
- Is data collection optional? Required for the categories above (they're needed to make estimates and invoices).
- Is data processed ephemerally? No.
- Data deletion: users can delete in the app or request deletion at the URL above.
