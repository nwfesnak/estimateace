-- ============================================================================
-- EstimateAce — Crew seat monthly subscriptions ($14.99 / seat)
-- Run in Supabase SQL Editor after crew-members.sql.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.crew_seat_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  crew_member_id UUID REFERENCES public.crew_members(id) ON DELETE SET NULL,
  crew_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  crew_email TEXT NOT NULL,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'incomplete',
  current_period_end TIMESTAMPTZ,
  cancel_at_period_end BOOLEAN NOT NULL DEFAULT false,
  amount_cents INTEGER NOT NULL DEFAULT 1499,
  currency TEXT NOT NULL DEFAULT 'usd',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_crew_seat_subs_owner
  ON public.crew_seat_subscriptions (owner_user_id);

CREATE INDEX IF NOT EXISTS idx_crew_seat_subs_stripe
  ON public.crew_seat_subscriptions (stripe_subscription_id);

CREATE INDEX IF NOT EXISTS idx_crew_seat_subs_crew
  ON public.crew_seat_subscriptions (crew_user_id);

-- Optional columns on crew_members for quick access checks
ALTER TABLE public.crew_members
  ADD COLUMN IF NOT EXISTS seat_status TEXT DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS seat_period_end TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS seat_cancel_at_period_end BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;

ALTER TABLE public.crew_seat_subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Owners manage crew_seat_subscriptions" ON public.crew_seat_subscriptions;
CREATE POLICY "Owners manage crew_seat_subscriptions"
  ON public.crew_seat_subscriptions
  FOR ALL
  TO authenticated
  USING (auth.uid() = owner_user_id)
  WITH CHECK (auth.uid() = owner_user_id);

COMMENT ON TABLE public.crew_seat_subscriptions IS
  'Month-to-month $14.99 crew seats. cancel_at_period_end keeps access until current_period_end.';
