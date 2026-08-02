-- ============================================================================
-- EstimateAce — Crew / sub-contractor real logins
-- Run in Supabase SQL Editor (production project) after rls-policies.sql.
--
-- Owners invite crew with email + password via the app.
-- Crew sign in on the SAME login form as owners (no separate crew login).
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.crew_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  crew_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'limited' CHECK (role IN ('full', 'limited')),
  can_see_pricing BOOLEAN NOT NULL DEFAULT false,
  can_see_estimates_and_financials BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, crew_user_id),
  UNIQUE (crew_user_id)
);

CREATE INDEX IF NOT EXISTS idx_crew_members_owner
  ON public.crew_members (owner_user_id);

CREATE INDEX IF NOT EXISTS idx_crew_members_crew
  ON public.crew_members (crew_user_id);

CREATE INDEX IF NOT EXISTS idx_crew_members_email
  ON public.crew_members (lower(email));

ALTER TABLE public.crew_members ENABLE ROW LEVEL SECURITY;

-- Owners manage their crew list; crew can read their own row
DROP POLICY IF EXISTS "Owners manage crew_members" ON public.crew_members;
CREATE POLICY "Owners manage crew_members"
  ON public.crew_members
  FOR ALL
  TO authenticated
  USING (auth.uid() = owner_user_id)
  WITH CHECK (auth.uid() = owner_user_id);

DROP POLICY IF EXISTS "Crew can read own membership" ON public.crew_members;
CREATE POLICY "Crew can read own membership"
  ON public.crew_members
  FOR SELECT
  TO authenticated
  USING (auth.uid() = crew_user_id);

-- Helper: is the current user crew of this owner?
CREATE OR REPLACE FUNCTION public.is_crew_of(owner_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.crew_members cm
    WHERE cm.owner_user_id = owner_id
      AND cm.crew_user_id = auth.uid()
  );
$$;

REVOKE ALL ON FUNCTION public.is_crew_of(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_crew_of(uuid) TO authenticated;

-- Extra RLS so crew can work in the owner's workspace
DROP POLICY IF EXISTS "Crew can view owner estimates" ON public.estimates;
CREATE POLICY "Crew can view owner estimates"
  ON public.estimates
  FOR SELECT
  TO authenticated
  USING (public.is_crew_of(user_id));

DROP POLICY IF EXISTS "Crew can insert owner estimates" ON public.estimates;
CREATE POLICY "Crew can insert owner estimates"
  ON public.estimates
  FOR INSERT
  TO authenticated
  WITH CHECK (public.is_crew_of(user_id));

DROP POLICY IF EXISTS "Crew can update owner estimates" ON public.estimates;
CREATE POLICY "Crew can update owner estimates"
  ON public.estimates
  FOR UPDATE
  TO authenticated
  USING (public.is_crew_of(user_id))
  WITH CHECK (public.is_crew_of(user_id));

DROP POLICY IF EXISTS "Crew can delete owner estimates" ON public.estimates;
CREATE POLICY "Crew can delete owner estimates"
  ON public.estimates
  FOR DELETE
  TO authenticated
  USING (public.is_crew_of(user_id));

DROP POLICY IF EXISTS "Crew can view owner archives" ON public."archive-est";
CREATE POLICY "Crew can view owner archives"
  ON public."archive-est"
  FOR SELECT
  TO authenticated
  USING (public.is_crew_of(user_id));

DROP POLICY IF EXISTS "Crew can insert owner archives" ON public."archive-est";
CREATE POLICY "Crew can insert owner archives"
  ON public."archive-est"
  FOR INSERT
  TO authenticated
  WITH CHECK (public.is_crew_of(user_id));

DROP POLICY IF EXISTS "Crew can update owner archives" ON public."archive-est";
CREATE POLICY "Crew can update owner archives"
  ON public."archive-est"
  FOR UPDATE
  TO authenticated
  USING (public.is_crew_of(user_id))
  WITH CHECK (public.is_crew_of(user_id));

DROP POLICY IF EXISTS "Crew can delete owner archives" ON public."archive-est";
CREATE POLICY "Crew can delete owner archives"
  ON public."archive-est"
  FOR DELETE
  TO authenticated
  USING (public.is_crew_of(user_id));

-- Crew may read owner's subscription row (paywall still skipped for crew in app UI)
DROP POLICY IF EXISTS "Crew can view owner subscription" ON public.subscriptions;
CREATE POLICY "Crew can view owner subscription"
  ON public.subscriptions
  FOR SELECT
  TO authenticated
  USING (public.is_crew_of(user_id));

COMMENT ON TABLE public.crew_members IS
  'Links crew Supabase Auth users to an owner workspace. Crew log in on the main login form.';
