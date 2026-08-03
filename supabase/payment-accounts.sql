-- ============================================================================
-- Stripe Connect accounts for JOB payments (not SaaS subscriptions)
-- Run in Supabase SQL Editor. Does not change subscriptions table.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.payment_accounts (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  stripe_account_id TEXT,
  charges_enabled BOOLEAN NOT NULL DEFAULT false,
  payouts_enabled BOOLEAN NOT NULL DEFAULT false,
  details_submitted BOOLEAN NOT NULL DEFAULT false,
  -- 'express' Connect, or 'platform' = use platform Stripe for this user's jobs
  account_type TEXT NOT NULL DEFAULT 'express',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payment_accounts_stripe
  ON public.payment_accounts (stripe_account_id);

ALTER TABLE public.payment_accounts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read own payment_accounts" ON public.payment_accounts;
CREATE POLICY "Users read own payment_accounts"
  ON public.payment_accounts FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

-- Writes via service role only (API routes)

COMMENT ON TABLE public.payment_accounts IS
  'Stripe Connect Express accounts for collecting job/invoice payments. Separate from SaaS subscriptions.';
