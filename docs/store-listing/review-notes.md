# Notes for App Review (Apple) and App access (Google)

## Demo account (create before submitting; must stay working during review)
- Email: `appreview@estimateace.com`   ← create this account on the **web** (estimateace.com)
- Password: (choose a strong one and paste it into App Store Connect / Play Console only. Don't save it in this file.)
- Give it an **active plan** (comped / promo) and 3–4 sample jobs with photos, one estimate, one invoice and one AI Receptionist message, so the reviewer sees real screens.
- Don't connect a real Stripe payout account or a real phone line to it.

## Text to paste into "Notes" (Apple) / "Instructions" (Google)

EstimateAce is a free companion app to the EstimateAce web service for contractors (estimates, invoices, job photos, customer payments). An account is required; log in with the demo account above.

What to try:
1. Log in, open **New estimate**, and tap the camera button to take a job-site photo (the camera and microphone permission prompts appear here). Then attach a photo from the library (up to 5 photos) and add a short note. Generate an AI estimate and confirm you can edit the priced line items and any upsell suggestions. Open the PDF preview.
2. If the review device is a LiDAR-equipped Pro iPhone (iPhone 12 Pro or newer Pro models, iOS 16+), use **Room scan** to auto-fill floor and wall area, perimeter, ceiling height, and door and window counts. On iPhones without LiDAR, enter length, width and height manually — the scan button is hidden, which is expected. Measurements are a starting point and are not guaranteed exact; please edit a figure to confirm the contractor stays in control.
3. If the job has before-and-after AI concept renderings, confirm they are labelled as concept renderings on the estimate / customer approval view.
4. Open **Invoices** to see an invoice with a customer payment link. Links to Stripe and other websites open in Safari.
5. **Profile → Billing → Manage billing → Delete account** is the in-app account deletion (guideline 5.1.1(v)).

Payments (guideline 3.1.3(f)): EstimateAce subscriptions are sold only on our website. The app has no purchase buttons, prices or links to buy, and it only lets existing customers use the service. Payment links in invoices are for the contractor's **customers** paying for real-world construction and home services (guideline 3.1.5(a) physical goods/services), processed by Stripe.

The app loads our live web app inside a native shell, and adds native camera/video capture, LiDAR room scan on supported Pro iPhones (manual length × width × height on other devices), an offline screen, splash screen, system-browser handoff and in-app account deletion.

Contact: support@estimateace.com
