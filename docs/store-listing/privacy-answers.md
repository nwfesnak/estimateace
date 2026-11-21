# Store privacy questionnaires

Fill these in App Store Connect (App Privacy) and Google Play Console (Data safety + content rating). They match what the app actually collects today. Re-check them if you add analytics, ads, or push notifications.

Public URLs (live):

- Privacy policy: https://app.estimateace.com/privacy
- Terms of Service: https://app.estimateace.com/terms
- Account deletion request: https://app.estimateace.com/delete-account

A shorter label table also lives in `app-privacy.md`.

## Basics (both stores)

- **Tracking (Apple) / Data used for ads or sold (Google): No.** The Meta pixel is not loaded inside the native app. No data is shared with data brokers or used to track users across other companies' apps. Do **not** show Apple's App Tracking Transparency prompt.
- **Data sold: No. Data shared with third parties for their own use: No.** Supabase (hosting/auth), Stripe (payments), Twilio (SMS/voice), Resend (email), xAI (estimate AI), and Google Places (address autocomplete) act as processors on our behalf. Both stores treat that as "not shared" / "service providers."
- **Encrypted in transit: Yes** (HTTPS only).
- **Users can request deletion: Yes.** In the app: Profile → Billing → Manage billing → Delete account. On the web: https://app.estimateace.com/delete-account.
- **Contains ads: No. In-app purchases: No** (subscriptions are sold only on the website; the native app hides purchase CTAs).

## App Store "nutrition label"

**Data Used to Track You:** None.

**Data Linked to You** (all used for App Functionality; none for Tracking, Advertising, or Analytics):

| Category | Type | Why |
|---|---|---|
| Contact Info | Name | Account / company owner name; customer names the contractor enters |
| Contact Info | Email Address | Login email; customer emails |
| Contact Info | Phone Number | Business phone; customer phones; AI Receptionist callers |
| Contact Info | Physical Address | Business address; job-site addresses |
| Location | Coarse Location | Optional. Biases address autocomplete when the contractor types a job-site or customer address. The app uses approximate location only (`enableHighAccuracy: false`). Users can refuse the system prompt and still type an address. Not used for tracking or ads. |
| User Content | Photos or Videos | Job-site photos and walkthrough videos attached to estimates |
| User Content | Audio Data | Sound on walkthrough videos; AI Receptionist call recordings / transcripts |
| User Content | Customer Support | Messages sent with "Message EstimateAce" |
| User Content | Other User Content | Estimates, invoices, notes, receipts |
| Identifiers | User ID | Account ID |
| Purchases | Purchase History | Invoice and payment status for the contractor's own customers (card numbers are handled by Stripe and never stored by EstimateAce) |

**Data Not Linked to You:** None.

**Not collected:** precise location, contacts / address book, health, browsing history, search history, device ID for advertising, crash or performance analytics, payment card numbers.

Product-page wording can mention: "An EstimateAce account is required. Log in with your existing account; new accounts are created at estimateace.com."

## Google Play Data safety

- **Does your app collect or share any of the required user data types?** Yes (collected, not shared, as defined above).
- **Is all of the user data collected by your app encrypted in transit?** Yes.
- **Do you provide a way for users to request that their data is deleted?** Yes (in-app and at the deletion URL above).
- **Data collected to be sold or used for advertising / fraud-sharing with third parties for their own purposes?** No.

Declare these **collected** types, each **required** for app functionality (except Approximate location, which is optional — the user can deny the permission), **not ephemeral**, **encrypted in transit**, and **users can request deletion**:

| Google type | Matches |
|---|---|
| Personal info → Name | Owner and customer names |
| Personal info → Email address | Login and customer emails |
| Personal info → Phone number | Business, customer, and receptionist caller numbers |
| Personal info → Address | Business and job-site addresses |
| Personal info → User IDs | Account ID |
| Location → Approximate location | Optional address-autocomplete bias |
| Photos and videos | Job photos and videos |
| Audio → Voice or sound recordings | Video sound; receptionist recordings |
| App activity → Other user-generated content | Estimates, invoices, notes, receipts, support messages |
| Financial info → Purchase history | Contractor invoice / payment status (no card numbers) |

Do **not** declare: precise location, contacts, health, device or other IDs for ads, crash logs, performance analytics, web browsing, or payment card numbers (Stripe).

**Account deletion URL:** https://app.estimateace.com/delete-account

## Apple age rating

Answer **No / None** to every question (violence, sexual content, profanity, alcohol, drugs, gambling, horror, medical, contests, unrestricted web access). External links open in Safari, not an in-app unrestricted browser.

Expected rating: **4+**.

## Google Play content rating

- Category: **Utility, Productivity, Communication, or Other**.
- Answer **No** to violence, sexuality, language, controlled substances, gambling, and user-to-user public communication that is not moderated in a way Google asks about (contractors send documents to their own customers; there is no public social feed).
- Target audience: **18 and over** (the product is for trade businesses).
- Expected rating: **Everyone**.

## Processors (for your own records; not a "sharing" declaration)

- **Supabase** — account auth and database hosting
- **Stripe** — contractor SaaS billing on the website, and customer payments for real-world jobs
- **Twilio** — SMS and optional AI Receptionist voice
- **Resend** — transactional email
- **xAI** — AI-drafted estimate line items and concept renderings
- **Google Places** — address autocomplete (the query, and approximate location when permitted, are sent to Google)
