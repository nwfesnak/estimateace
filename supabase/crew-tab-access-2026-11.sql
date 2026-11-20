-- ============================================================================
-- EstimateAce — Per-tab crew permissions (2026-11)
--
-- Apply via Supabase SQL Editor or apply_migration (project jiujzujkednnkjymawdk).
-- Idempotent; deletes no rows.
--
--   1. Adds crew_members.tab_access JSONB DEFAULT NULL.
--      NULL preserves legacy behavior (all workspace tabs allowed) for existing
--      crew rows until the owner configures per-tab toggles.
--   2. Adds public.crew_has_tab(owner_id uuid, tab_key text) helper (seat-aware,
--      SECURITY DEFINER, not callable by anon/PUBLIC).
--   3. Tightens crew RLS policies on public.estimates and public."archive-est"
--      so full-access crew cannot bypass denied tabs via direct PostgREST calls.
--      (Restricted crew are already blocked by is_full_access_crew_of and served
--      via /api/crew/data/* which enforces the same tab rules + redaction.)
-- ============================================================================

ALTER TABLE public.crew_members
  ADD COLUMN IF NOT EXISTS tab_access JSONB DEFAULT NULL;

COMMENT ON COLUMN public.crew_members.tab_access IS
  'Per-tab crew access JSONB ({dashboard,estimates,invoices,newEstimate,reports,calendar,recurring,receptionist}); NULL means all workspace tabs allowed (legacy default).';

CREATE OR REPLACE FUNCTION public.crew_has_tab(owner_id uuid, tab_key text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT auth.uid() IS NOT NULL
    AND owner_id IS NOT NULL
    AND tab_key IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.crew_members cm
      WHERE cm.owner_user_id = owner_id
        AND cm.crew_user_id = auth.uid()
        AND (
          coalesce(cm.seat_status, 'active') IN ('active', 'trialing', 'past_due', 'canceling')
          OR (
            cm.seat_status IN ('canceled', 'unpaid')
            AND cm.seat_period_end IS NOT NULL
            AND cm.seat_period_end > now()
          )
        )
        AND (
          cm.tab_access IS NULL
          OR NOT (cm.tab_access ? tab_key)
          OR lower(coalesce(cm.tab_access ->> tab_key, 'true')) = 'true'
        )
    );
$$;

REVOKE ALL ON FUNCTION public.crew_has_tab(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.crew_has_tab(uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.crew_has_tab(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.crew_has_tab(uuid, text) TO service_role;

-- ---------------------------------------------------------------------------
-- estimates: full-access crew can only read/write document types for allowed tabs
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Crew can view owner estimates" ON public.estimates;
CREATE POLICY "Crew can view owner estimates" ON public.estimates
  FOR SELECT TO authenticated
  USING (
    public.is_full_access_crew_of(user_id)
    AND (
      id = 'SETTINGS-' || user_id::text
      OR (
        (id LIKE 'REC-%' OR lower(coalesce("documentType", '')) = 'recurring_plan')
        AND (public.crew_has_tab(user_id, 'recurring') OR public.crew_has_tab(user_id, 'reports'))
      )
      OR (
        lower(coalesce("documentType", '')) = 'invoice'
        AND id NOT LIKE 'SETTINGS-%'
        AND id NOT LIKE 'REC-%'
        AND public.crew_has_tab(user_id, 'invoices')
      )
      OR (
        lower(coalesce("documentType", '')) NOT IN ('invoice', 'recurring_plan')
        AND id NOT LIKE 'SETTINGS-%'
        AND id NOT LIKE 'REC-%'
        AND id NOT LIKE 'RECEPTIONIST-SECRETS-%'
        AND id NOT LIKE 'PLATFORM-%'
        AND public.crew_has_tab(user_id, 'estimates')
      )
    )
  );

DROP POLICY IF EXISTS "Crew can insert owner estimates" ON public.estimates;
CREATE POLICY "Crew can insert owner estimates" ON public.estimates
  FOR INSERT TO authenticated
  WITH CHECK (
    public.is_full_access_crew_of(user_id)
    AND id NOT LIKE 'SETTINGS-%'
    AND id NOT LIKE 'RECEPTIONIST-SECRETS-%'
    AND id NOT LIKE 'PLATFORM-%'
    AND (
      (
        (id LIKE 'REC-%' OR lower(coalesce("documentType", '')) = 'recurring_plan')
        AND public.crew_has_tab(user_id, 'recurring')
      )
      OR (
        lower(coalesce("documentType", '')) = 'invoice'
        AND id NOT LIKE 'REC-%'
        AND public.crew_has_tab(user_id, 'invoices')
      )
      OR (
        lower(coalesce("documentType", '')) NOT IN ('invoice', 'recurring_plan')
        AND id NOT LIKE 'REC-%'
        AND (public.crew_has_tab(user_id, 'estimates') OR public.crew_has_tab(user_id, 'newEstimate'))
      )
    )
  );

DROP POLICY IF EXISTS "Crew can update owner estimates" ON public.estimates;
CREATE POLICY "Crew can update owner estimates" ON public.estimates
  FOR UPDATE TO authenticated
  USING (
    public.is_full_access_crew_of(user_id)
    AND id NOT LIKE 'SETTINGS-%'
    AND id NOT LIKE 'RECEPTIONIST-SECRETS-%'
    AND id NOT LIKE 'PLATFORM-%'
    AND (
      (
        (id LIKE 'REC-%' OR lower(coalesce("documentType", '')) = 'recurring_plan')
        AND public.crew_has_tab(user_id, 'recurring')
      )
      OR (
        lower(coalesce("documentType", '')) = 'invoice'
        AND id NOT LIKE 'REC-%'
        AND public.crew_has_tab(user_id, 'invoices')
      )
      OR (
        lower(coalesce("documentType", '')) NOT IN ('invoice', 'recurring_plan')
        AND id NOT LIKE 'REC-%'
        AND (public.crew_has_tab(user_id, 'estimates') OR public.crew_has_tab(user_id, 'newEstimate'))
      )
    )
  )
  WITH CHECK (
    public.is_full_access_crew_of(user_id)
    AND id NOT LIKE 'SETTINGS-%'
    AND id NOT LIKE 'RECEPTIONIST-SECRETS-%'
    AND id NOT LIKE 'PLATFORM-%'
    AND (
      (
        (id LIKE 'REC-%' OR lower(coalesce("documentType", '')) = 'recurring_plan')
        AND public.crew_has_tab(user_id, 'recurring')
      )
      OR (
        lower(coalesce("documentType", '')) = 'invoice'
        AND id NOT LIKE 'REC-%'
        AND public.crew_has_tab(user_id, 'invoices')
      )
      OR (
        lower(coalesce("documentType", '')) NOT IN ('invoice', 'recurring_plan')
        AND id NOT LIKE 'REC-%'
        AND (public.crew_has_tab(user_id, 'estimates') OR public.crew_has_tab(user_id, 'newEstimate'))
      )
    )
  );

-- ---------------------------------------------------------------------------
-- archive-est: requires reports tab
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Crew can view owner archives" ON public."archive-est";
CREATE POLICY "Crew can view owner archives" ON public."archive-est"
  FOR SELECT TO authenticated
  USING (public.is_full_access_crew_of(user_id) AND public.crew_has_tab(user_id, 'reports'));

DROP POLICY IF EXISTS "Crew can insert owner archives" ON public."archive-est";
CREATE POLICY "Crew can insert owner archives" ON public."archive-est"
  FOR INSERT TO authenticated
  WITH CHECK (public.is_full_access_crew_of(user_id) AND public.crew_has_tab(user_id, 'reports'));

DROP POLICY IF EXISTS "Crew can update owner archives" ON public."archive-est";
CREATE POLICY "Crew can update owner archives" ON public."archive-est"
  FOR UPDATE TO authenticated
  USING (public.is_full_access_crew_of(user_id) AND public.crew_has_tab(user_id, 'reports'))
  WITH CHECK (public.is_full_access_crew_of(user_id) AND public.crew_has_tab(user_id, 'reports'));
