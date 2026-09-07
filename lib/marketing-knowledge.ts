/**
 * Knowledge base for the public EstimateAce marketing chat assistant.
 * Keep factual and aligned with the live product / pricing pages.
 */
export const MARKETING_KNOWLEDGE = `
EstimateAce is contractor estimating and operations software (web app + installable PWA).
App URL: https://app.estimateace.com
Marketing site: https://estimateace.com

PRODUCT
- AI estimates from job photos (Grok / xAI): snap a site photo, get line items and pricing suggestions.
- AI auto estimate / price quotes and AI description polish for customer-ready scopes.
- Unlimited estimates and invoices; convert estimate to invoice; deposits and balance due.
- Client approve / pay links (Stripe Checkout when Connect is set up; also Venmo/PayPal/Zelle/mail options).
- Scheduling / calendar and optional SMS + email appointment reminders.
- Photos, video, receipts, labor and mileage tracking.
- Reports: Profit, Paid invoices, Estimates archive, Recurring, Tax.
- Recurring charges for maintenance-style plans.
- Crew / teammate logins with permission controls.
- AI Receptionist is BETA: knowledge base + test call in-app. Live phone answering / call forwarding is NOT available yet (coming later / third party). Do not claim live phone answering works today.
- Works in browser; no App Store required; can install as PWA (Add to Home Screen).

PRICING
- Monthly: $29.99/month after trial.
- Yearly: $249/year after trial.
- Standard signup: 14-day free trial via https://app.estimateace.com/trial
- Promo landers: 2 months free (https://estimateace.com/2-months-free.html → trial?promo=2mo), 6 months free (https://estimateace.com/6-months-free.html → trial?promo=6mo).
- Cancel anytime in Profile → Billing / Contact Us before trial ends to avoid charges.
- Soft launch: billing enforce may be off; still describe paid plans honestly.

WHO IT IS FOR
- Painters, remodelers, HVAC, plumbing, exterior / pressure washing, general contractors, field service crews who quote on-site.

HOW TO START
- New accounts: https://app.estimateace.com/trial (or promo URLs above).
- Existing users: https://app.estimateace.com (Log in).
- Terms: https://app.estimateace.com/terms — Privacy: https://app.estimateace.com/privacy

SUPPORT
- In-app: Profile → Billing / Contact Us → Message EstimateAce.
- Do not invent features, prices, or legal claims not listed here.
`.trim();

export const MARKETING_FALLBACK =
  "I don't have a solid answer for that yet. We've saved your question and someone from EstimateAce will get back to you within 49 hours. You can also start a free trial at https://app.estimateace.com/trial";
