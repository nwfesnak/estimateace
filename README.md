# EstimateAce

Professional contractor estimating & invoicing tool with AI assistance.

## Features
- Create estimates and convert to invoices
- AI-powered line item pricing and description improvement (via xAI Grok)
- Photo/video/receipt capture + storage
- Labor, tax calculation, quick lines, templates
- Crew / Sub-contractors management with simulated monthly billing
- Reports, exports, archiving
- Basic profile + payment method settings (demo)

**Note**: Payments and crew subscriptions are fully simulated (demo mode). No real charges occur.

## Setup

1. Copy environment variables:
   ```bash
   cp .env.example .env.local
   ```

2. Fill in your keys in `.env.local`:
   - `GROK_API_KEY` — from https://console.x.ai/ (server-side only, do NOT use NEXT_PUBLIC_). In Vercel: Settings → Environment Variables → Add New. Key: `GROK_API_KEY`, Value: your key from console.x.ai. Then redeploy.
   - Supabase URL + Anon key

3. **Create the required database schema** (run in Supabase SQL Editor):
   ```bash
   -- Copy & paste the contents of supabase/schema.sql
   -- Then apply the policies from supabase/rls-policies.sql
   ```
   - Also create a Storage bucket named `media`.

3. Install & run:
   ```bash
   npm install
   npm run dev
   ```

Open http://localhost:3000

## Production / Going Live (Vercel)

### 1. Environment Variable Separation (Critical)
- **Never** commit real secrets. `.env*` files are already ignored by `.gitignore`.
- Create **separate** Supabase projects:
  - One for Development / Preview
  - One for Production
- In Vercel Dashboard:
  - Go to Project → Settings → Environment Variables
  - Add variables for **Development**, **Preview**, and **Production** separately
  - Use different `GROK_API_KEY` and Supabase keys per environment

### 2. Content Security Policy (CSP) + Security Headers
- CSP and other headers (X-Frame-Options, HSTS, etc.) have been added in `next.config.mjs`.
- Review and adjust the CSP if you add new external services.

### 3. Supabase Security
- **Enable and test Row Level Security (RLS)** on `estimates` and `archive-est` tables.
- Restrict storage bucket `media` policies to the owner's folder only.
- Use the production Supabase project (enable email confirmations, password breach protection).

### 4. API Security
- The API routes (`/api/grok`, `/api/ai-quote`) should be protected in production.
- Consider adding auth checks using the Supabase session token.

### 5. Demo vs Production Code
- Crew/subcontractor passwords are stored in plaintext (demo only).
- 2FA, payments, and crew login are fully simulated.
- Replace or heavily gate these before real users.

### 6. Regular Security Maintenance
```bash
npm run audit          # Check high/critical issues
npm run audit:fix      # Apply safe fixes
npm audit              # Full report
```
- Run `npm audit` before every deploy.
- Currently only moderate issues remain (internal to Next.js — do **not** run `--force`).

### 7. Vercel-Specific Recommendations
- Add your custom domain in Vercel (automatically gets HTTPS + HSTS).
- Enable Vercel Analytics or Speed Insights.
- Set up preview deployments for testing.
- Use Vercel Environment Variables (never hardcode keys).

### 8. Pre-Deploy Checklist
- [ ] Run `npm run build` successfully
- [ ] Run `npm run audit`
- [ ] Set up separate Supabase prod project + RLS
- [ ] Configure all env vars in Vercel (3 environments)
- [ ] Test login, estimate creation, media upload on production domain
- [ ] Remove/hide demo features or add clear "Demo" banners
- [ ] Review CSP if adding new domains/APIs

## Deploy
Recommended: Vercel (one-click from Git).

```bash
# Local production test
npm run build
npm run start
```

## Tech
Next.js 16 + React 19 + Tailwind + Supabase + xAI

## Scripts
- `npm run dev` — Start development server
- `npm run build` — Production build
- `npm run start` — Start production server
- `npm run lint`
- `npm run audit` — Check for high/critical vulnerabilities
- `npm run audit:fix` — Apply safe vulnerability fixes
