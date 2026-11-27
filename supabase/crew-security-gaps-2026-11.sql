-- ============================================================================
-- EstimateAce — Crew security gaps (2026-11)
--
-- DO NOT APPLY until Nathan approves this PR. Idempotent; deletes no rows.
-- Apply via Supabase SQL Editor (production project jiujzujkednnkjymawdk)
-- AFTER the matching app deploy, or together with it.
--
-- Closes:
--   1. Full-data crew could SELECT the owner's SETTINGS-<owner> row (profile
--      JSONB), including twoFactorPhone, paymentSettings, aiPriceMemory, and
--      receptionistBilling. Crew SELECT of SETTINGS is now denied. A
--      security-definer RPC public.crew_company_display() returns letterhead
--      only (company, logo, address, phone, email, slogan, certificate, terms).
--   2. Re-asserts tab-aware RLS from crew-tab-access-2026-11.sql so full-data
--      crew cannot read/write documents for denied tabs via PostgREST.
--   3. Storage: treat media kind "line-photo" the same as "photo"
--      (view for any active crew; upload for active crew; replace = full-data
--      crew only; no crew deletes).
--   4. No crew DELETE on estimates / archive-est (owner only).
--
-- Also re-creates the seat-aware helpers (is_crew_of, is_full_access_crew_of,
-- is_financial_crew_of, crew_has_tab) so this file is safe if an earlier
-- hardening migration was missed.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- Helpers (seat-aware; same rules as launch-hardening / 11c / 11d / tab-access)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_crew_of(owner_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT auth.uid() IS NOT NULL
    AND owner_id IS NOT NULL
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
    );
$function$;

REVOKE ALL ON FUNCTION public.is_crew_of(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_crew_of(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.is_crew_of(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_crew_of(uuid) TO service_role;

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

CREATE OR REPLACE FUNCTION public.is_financial_crew_of(owner_id uuid)
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

REVOKE ALL ON FUNCTION public.is_financial_crew_of(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_financial_crew_of(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.is_financial_crew_of(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_financial_crew_of(uuid) TO service_role;

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
-- Letterhead-only SETTINGS read for crew (no secrets)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.crew_company_display()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  owner uuid;
  prof jsonb;
  display jsonb := '{}'::jsonb;
  k text;
  keys text[] := ARRAY[
    'company',
    'slogan',
    'logo',
    'logoUrl',
    'logoSize',
    'certificateUrl',
    'phone',
    'email',
    'address',
    'city',
    'state',
    'zipCode',
    'zip',
    'website',
    'license',
    'licenseNumber',
    'tradeId',
    'trade',
    'terms'
  ];
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT cm.owner_user_id
    INTO owner
  FROM public.crew_members cm
  WHERE cm.crew_user_id = auth.uid()
    AND (
      coalesce(cm.seat_status, 'active') IN ('active', 'trialing', 'past_due', 'canceling')
      OR (
        cm.seat_status IN ('canceled', 'unpaid')
        AND cm.seat_period_end IS NOT NULL
        AND cm.seat_period_end > now()
      )
    )
  LIMIT 1;

  IF owner IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT e.profile
    INTO prof
  FROM public.estimates e
  WHERE e.id = 'SETTINGS-' || owner::text
    AND e.user_id = owner;

  IF prof IS NOT NULL AND jsonb_typeof(prof) = 'object' THEN
    FOREACH k IN ARRAY keys LOOP
      IF prof ? k THEN
        display := display || jsonb_build_object(k, prof -> k);
      END IF;
    END LOOP;
  END IF;

  RETURN jsonb_build_object('ownerUserId', owner, 'profile', display);
END;
$$;

REVOKE ALL ON FUNCTION public.crew_company_display() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.crew_company_display() FROM anon;
GRANT EXECUTE ON FUNCTION public.crew_company_display() TO authenticated;
GRANT EXECUTE ON FUNCTION public.crew_company_display() TO service_role;

COMMENT ON FUNCTION public.crew_company_display() IS
  'Active crew only. Returns owner letterhead fields (company, logo, address, phone, email). Never twoFactorPhone, paymentSettings, aiPriceMemory, or receptionistBilling.';

-- ---------------------------------------------------------------------------
-- estimates: tab-aware full-data crew access; NO SETTINGS row for crew
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Crew can view owner estimates" ON public.estimates;
CREATE POLICY "Crew can view owner estimates" ON public.estimates
  FOR SELECT TO authenticated
  USING (
    public.is_full_access_crew_of(user_id)
    AND id NOT LIKE 'SETTINGS-%'
    AND id NOT LIKE 'RECEPTIONIST-SECRETS-%'
    AND id NOT LIKE 'PLATFORM-%'
    AND (
      (
        (id LIKE 'REC-%' OR lower(coalesce("documentType", '')) = 'recurring_plan')
        AND (public.crew_has_tab(user_id, 'recurring') OR public.crew_has_tab(user_id, 'reports'))
      )
      OR (
        lower(coalesce("documentType", '')) = 'invoice'
        AND id NOT LIKE 'REC-%'
        AND public.crew_has_tab(user_id, 'invoices')
      )
      OR (
        lower(coalesce("documentType", '')) NOT IN ('invoice', 'recurring_plan')
        AND id NOT LIKE 'REC-%'
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

-- Crew must never hard-delete owner documents (UI and /api/crew/data already refuse).
DROP POLICY IF EXISTS "Crew can delete owner estimates" ON public.estimates;

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

DROP POLICY IF EXISTS "Crew can delete owner archives" ON public."archive-est";

-- ---------------------------------------------------------------------------
-- Storage: line-photo uses the same rules as photo
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.media_owner_id(object_name text)
RETURNS uuid
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN split_part(object_name, '/', 1) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN split_part(object_name, '/', 1)::uuid
    ELSE NULL
  END;
$$;

CREATE OR REPLACE FUNCTION public.media_kind(object_name text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT lower(split_part(object_name, '/', 2));
$$;

GRANT EXECUTE ON FUNCTION public.media_owner_id(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.media_kind(text) TO authenticated, service_role;

DROP POLICY IF EXISTS "Crew can view owner media" ON storage.objects;
CREATE POLICY "Crew can view owner media"
ON storage.objects
FOR SELECT
TO authenticated
USING (
  bucket_id = 'media'
  AND public.is_crew_of(public.media_owner_id(name))
  AND (
    public.media_kind(name) <> 'receipt'
    OR public.is_financial_crew_of(public.media_owner_id(name))
  )
);

DROP POLICY IF EXISTS "Crew can upload owner media" ON storage.objects;
CREATE POLICY "Crew can upload owner media"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'media'
  AND (
    public.is_full_access_crew_of(public.media_owner_id(name))
    OR (
      public.is_crew_of(public.media_owner_id(name))
      AND public.media_kind(name) IN ('photo', 'video', 'render', 'line-photo')
    )
    OR (
      public.media_kind(name) = 'receipt'
      AND public.is_financial_crew_of(public.media_owner_id(name))
    )
  )
);

DROP POLICY IF EXISTS "Crew can update owner media" ON storage.objects;
CREATE POLICY "Crew can update owner media"
ON storage.objects
FOR UPDATE
TO authenticated
USING (
  bucket_id = 'media'
  AND public.is_full_access_crew_of(public.media_owner_id(name))
)
WITH CHECK (
  bucket_id = 'media'
  AND public.is_full_access_crew_of(public.media_owner_id(name))
);

DROP POLICY IF EXISTS "Crew can delete owner media" ON storage.objects;

COMMIT;

-- ---------------------------------------------------------------------------
-- Verification (read-only; run after apply). Expected notes in comments.
-- Full checklist: scripts/verify-crew-security-gaps.sql
-- ---------------------------------------------------------------------------
-- 1. Crew estimates SELECT policy must NOT allow SETTINGS-% rows:
--    SELECT qual FROM pg_policies
--    WHERE tablename = 'estimates' AND policyname = 'Crew can view owner estimates';
--    -- qual contains: id NOT LIKE 'SETTINGS-%'
--    -- qual does NOT contain: id = 'SETTINGS-' || user_id
-- 2. crew_company_display exists; anon cannot execute:
--    SELECT has_function_privilege('anon', 'public.crew_company_display()', 'EXECUTE');  -- false
-- 3. Upload policy allows line-photo:
--    SELECT with_check FROM pg_policies
--    WHERE schemaname = 'storage' AND policyname = 'Crew can upload owner media';
--    -- contains 'line-photo'
-- 4. No crew DELETE policies:
--    SELECT policyname FROM pg_policies
--    WHERE policyname ILIKE 'Crew can delete%';  -- 0 rows
