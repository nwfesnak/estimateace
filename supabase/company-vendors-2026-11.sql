-- ============================================================================
-- EstimateAce — Saved labor vendors (2026-11)
--
-- Apply via Supabase SQL Editor or apply_migration (project jiujzujkednnkjymawdk)
-- at merge time. Do not apply to production until this PR is merged.
-- Idempotent; deletes no rows.
--
-- Company-scoped saved vendors for the labor popup. This app has no separate
-- companies table: company_id is the workspace owner's auth user id
-- (the same id as estimates.user_id / crew_members.owner_user_id).
--
--   Owners (auth.uid() = company_id) can read and write.
--   Crew / staff (is_crew_of(company_id)) can read, so they can pick a saved
--   vendor when logging labor, but cannot insert, update, or delete the list.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.company_vendors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  trade TEXT,
  phone TEXT,
  email TEXT,
  rate NUMERIC,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT company_vendors_name_not_blank CHECK (length(btrim(name)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_company_vendors_company
  ON public.company_vendors (company_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_company_vendors_company_name
  ON public.company_vendors (company_id, lower(btrim(name)));

COMMENT ON TABLE public.company_vendors IS
  'Saved labor vendors (subs / people the company pays often). company_id is the workspace owner user id.';

COMMENT ON COLUMN public.company_vendors.company_id IS
  'Workspace owner (auth.users id). Same meaning as estimates.user_id.';

COMMENT ON COLUMN public.company_vendors.rate IS
  'Optional default hourly rate applied when the vendor is picked in the labor popup.';

ALTER TABLE public.company_vendors ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Owners and crew can read company_vendors" ON public.company_vendors;
CREATE POLICY "Owners and crew can read company_vendors"
  ON public.company_vendors
  FOR SELECT
  TO authenticated
  USING (
    auth.uid() = company_id
    OR public.is_crew_of(company_id)
  );

DROP POLICY IF EXISTS "Owners can insert company_vendors" ON public.company_vendors;
CREATE POLICY "Owners can insert company_vendors"
  ON public.company_vendors
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = company_id);

DROP POLICY IF EXISTS "Owners can update company_vendors" ON public.company_vendors;
CREATE POLICY "Owners can update company_vendors"
  ON public.company_vendors
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = company_id)
  WITH CHECK (auth.uid() = company_id);

DROP POLICY IF EXISTS "Owners can delete company_vendors" ON public.company_vendors;
CREATE POLICY "Owners can delete company_vendors"
  ON public.company_vendors
  FOR DELETE
  TO authenticated
  USING (auth.uid() = company_id);

REVOKE ALL ON TABLE public.company_vendors FROM PUBLIC;
REVOKE ALL ON TABLE public.company_vendors FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.company_vendors TO authenticated;
GRANT ALL ON TABLE public.company_vendors TO service_role;
