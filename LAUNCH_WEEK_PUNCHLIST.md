# Launch-week punch-list (updated)

## Fixed in code (this pass)

| Item | Status |
|------|--------|
| Marketing root shim (`index.html` → marketing-landing) | **Fixed** — `index.html` is full landing; `index.php` remains primary DirectoryIndex |
| Resources `#` placeholders on marketing landing | **Fixed** — point to `resources.php`, app tutorials, support, receptionist |
| AI Receptionist marketed as live phone | **Fixed** — live paid add-on (forward + answer + leads); not beta |
| Login “Main Account” / wrong crew password copy | **Fixed** — “Log In” + crew email/password from owner |
| CORS `Access-Control-Allow-Origin: *` on marketing chat | **Hardened** — allowlist only; no `*` and no foreign Origin reflect |
| Privacy light on xAI retention/training | **Expanded** — API inference, no EA training claim, link to x.ai + Twilio transcripts |
| Terms beta receptionist / crew billing | **Updated** — receptionist paid add-on; crew seats live; evolving features called out |
| CSP `unsafe-inline` | **Documented** — kept for Next.js until nonce migration; unsafe-eval still out |

## Confirm in ops (you)

1. **Stripe Live** — Vercel Production `STRIPE_SECRET_KEY` starts with `sk_live_`, publishable `pk_live_`. If the app shows “test mode”, swap keys and redeploy.
2. **Hostinger upload** — upload updated `website/index.html`, `marketing-landing.html`, `receptionist.php` (and resources if needed).
3. **Logged-in E2E** — photo → estimate → invoice → pay → SMS once with a real trial account.

## Suggested framing this week

**Early access / soft launch is fine**, but product claims should match: AI Receptionist is a **paid live add-on** (with carrier-forward setup + speech caveats), crew seats are **$14.99/mo**, core estimate→invoice→pay is the main path.
