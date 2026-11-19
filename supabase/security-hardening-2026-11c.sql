-- ============================================================================
-- EstimateAce security hardening, part 3 (2026-11)
--
-- Run in Supabase SQL Editor (or apply as a migration) BEFORE deploying the code
-- that ships with it. Idempotent; deletes no rows.
--
--   1. Crew access levels enforced by the database.
--      Only crew whose owner ticked BOTH "See pricing" and "See estimates &
--      financials" may read/write the owner's estimates + archive rows directly.
--      Every other crew member is served by /api/crew/data (server-side redaction of
--      prices / financials; see lib/crew-redaction.ts). Owners are unaffected.
--   2. stripe_disputes: one row per Stripe dispute (platform + connected accounts),
--      written only by the server (webhooks). Owners can read their own rows.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Crew with full data access (both permission flags) — same seat rules as is_crew_of
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_full_access_crew_of(owner_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT auth.uid() IS NOT NULL
    AND owner_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.crew_members cm
      WHERE cm.owner_user_id = owner_id
        AND cm.crew_user_id = auth.uid()
        AND cm.can_see_pricing = true
        AND cm.can_see_estimates_and_financials = true
        AND (
          coalesce(cm.seat_status, 'active') IN ('active', 'trialing', 'past_due', 'canceling')
          OR (
            cm.seat_status IN ('canceled', 'unpaid')
            AND cm.seat_period_end IS NOT NULL
            AND cm.seat_period_end > now()
          )
        )
    );
$$;

REVOKE ALL ON FUNCTION public.is_full_access_crew_of(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_full_access_crew_of(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.is_full_access_crew_of(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_full_access_crew_of(uuid) TO service_role;

-- estimates: crew view / insert / update only with full data access
DROP POLICY IF EXISTS "Crew can view owner estimates" ON public.estimates;
CREATE POLICY "Crew can view owner estimates" ON public.estimates
  FOR SELECT TO authenticated
  USING (public.is_full_access_crew_of(user_id));

DROP POLICY IF EXISTS "Crew can insert owner estimates" ON public.estimates;
CREATE POLICY "Crew can insert owner estimates" ON public.estimates
  FOR INSERT TO authenticated
  WITH CHECK (public.is_full_access_crew_of(user_id));

DROP POLICY IF EXISTS "Crew can update owner estimates" ON public.estimates;
CREATE POLICY "Crew can update owner estimates" ON public.estimates
  FOR UPDATE TO authenticated
  USING (public.is_full_access_crew_of(user_id))
  WITH CHECK (public.is_full_access_crew_of(user_id));

-- archive-est (paid / archived work): same rule
DROP POLICY IF EXISTS "Crew can view owner archives" ON public."archive-est";
CREATE POLICY "Crew can view owner archives" ON public."archive-est"
  FOR SELECT TO authenticated
  USING (public.is_full_access_crew_of(user_id));

DROP POLICY IF EXISTS "Crew can insert owner archives" ON public."archive-est";
CREATE POLICY "Crew can insert owner archives" ON public."archive-est"
  FOR INSERT TO authenticated
  WITH CHECK (public.is_full_access_crew_of(user_id));

DROP POLICY IF EXISTS "Crew can update owner archives" ON public."archive-est";
CREATE POLICY "Crew can update owner archives" ON public."archive-est"
  FOR UPDATE TO authenticated
  USING (public.is_full_access_crew_of(user_id))
  WITH CHECK (public.is_full_access_crew_of(user_id));

-- ---------------------------------------------------------------------------
-- 2. Stripe disputes (chargebacks)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.stripe_disputes (
  dispute_id          TEXT PRIMARY KEY,
  scope               TEXT NOT NULL CHECK (scope IN ('platform', 'connect')),
  livemode            BOOLEAN NOT NULL DEFAULT true,
  stripe_account_id   TEXT,
  owner_user_id       UUID REFERENCES auth.users (id) ON DELETE SET NULL,
  charge_id           TEXT,
  payment_intent_id   TEXT,
  document_id         TEXT,
  amount              BIGINT,
  currency            TEXT,
  reason              TEXT,
  status              TEXT,
  evidence_due_by     TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at           TIMESTAMPTZ,
  -- one-time notification markers (claimed atomically before sending)
  opened_notified_at  TIMESTAMPTZ,
  closed_notified_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS stripe_disputes_owner_idx
  ON public.stripe_disputes (owner_user_id, created_at DESC);

ALTER TABLE public.stripe_disputes ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.stripe_disputes FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.stripe_disputes FROM authenticated;
GRANT SELECT ON public.stripe_disputes TO authenticated;

DROP POLICY IF EXISTS "Owners read own disputes" ON public.stripe_disputes;
CREATE POLICY "Owners read own disputes" ON public.stripe_disputes
  FOR SELECT TO authenticated
  USING (auth.uid() = owner_user_id);

COMMIT;

-- Verification (run after):
--   SELECT tablename, policyname, cmd, qual, with_check FROM pg_policies
--   WHERE tablename IN ('estimates','archive-est') AND policyname ILIKE '%crew%';
--     -- expect 6 rows, all using is_full_access_crew_of(user_id)
--   SELECT relrowsecurity FROM pg_class WHERE oid = 'public.stripe_disputes'::regclass;  -- true
--   SELECT policyname, cmd FROM pg_policies WHERE tablename = 'stripe_disputes';  -- 1 SELECT
