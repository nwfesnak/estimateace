-- ============================================================================
-- EstimateAce Phase A — SaaS subscription status (per owner account)
-- Run in Supabase SQL Editor (production project).
-- Webhook uses service role; users can only SELECT their own row.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.subscriptions (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  status TEXT NOT NULL DEFAULT 'none',
  price_id TEXT,
  current_period_end TIMESTAMPTZ,
  trial_ends_at TIMESTAMPTZ,
  cancel_at_period_end BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_customer
  ON public.subscriptions (stripe_customer_id);

CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_sub
  ON public.subscriptions (stripe_subscription_id);

ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own subscription" ON public.subscriptions;
CREATE POLICY "Users can view own subscription"
  ON public.subscriptions
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- Inserts/updates from the app go through server routes with service role
-- (no client write policies on purpose).

COMMENT ON TABLE public.subscriptions IS 'Stripe subscription snapshot for EstimateAce product access.';
