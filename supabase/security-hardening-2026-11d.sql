-- ============================================================================
-- EstimateAce security hardening, part 4 (2026-11)
--
-- Storage (media bucket) access for crew, matching their access level.
-- Idempotent; deletes no rows or files; owners are unaffected.
--
--   Owner (folder = own user id)         view / upload / replace / delete (unchanged)
--   Full-access crew (both permissions)  view all, upload, replace. No deletes.
--   Crew with "See estimates & financials" only:
--                                        view all (incl. receipts), add new photos,
--                                        videos, renders and receipts. No replace/delete.
--   Other (limited) crew                 view everything EXCEPT receipts; add new
--                                        photos / videos / renders only. No replace/delete.
--   Inactive / pending / expired seats   nothing (same seat rule as is_crew_of)
--
-- Deletes of owner files are owner-only. "Add new" means a fresh, uniquely named
-- file (the app uploads with upsert off), so crew can never overwrite owner files.
-- ============================================================================

BEGIN;

-- Crew who may see financial records (receipts): "See estimates & financials" ticked,
-- seat active. Same seat rules as public.is_crew_of / is_full_access_crew_of.
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

-- Folder names are "<owner uuid>/<kind>/<file>". Non-uuid first segments (legacy
-- stray objects) must not make the cast throw, so parse defensively.
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

-- VIEW: any active crew, except receipts need the financials permission.
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

-- ADD NEW FILES: full-access crew anywhere; other crew only job media
-- (photo / video / render), plus receipts with the financials permission.
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
      AND public.media_kind(name) IN ('photo', 'video', 'render')
    )
    OR (
      public.media_kind(name) = 'receipt'
      AND public.is_financial_crew_of(public.media_owner_id(name))
    )
  )
);

-- REPLACE (update/overwrite): full-access crew only.
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

-- DELETE: owner only (the "Users can delete their own media" policy). No crew deletes.
DROP POLICY IF EXISTS "Crew can delete owner media" ON storage.objects;

COMMIT;

-- ---------------------------------------------------------------------------
-- Checks (run after applying; expected results in comments)
-- ---------------------------------------------------------------------------
-- 1. Crew storage policies (expect 3 rows: SELECT, INSERT, UPDATE; no DELETE):
--    SELECT policyname, cmd FROM pg_policies
--    WHERE schemaname = 'storage' AND policyname LIKE 'Crew can %' ORDER BY cmd;
-- 2. Owner policies unchanged (expect 4 rows: SELECT, INSERT, UPDATE, DELETE):
--    SELECT policyname, cmd FROM pg_policies
--    WHERE schemaname = 'storage' AND policyname LIKE 'Users can %' ORDER BY cmd;
-- 3. New helper not callable by anon (expect false):
--    SELECT has_function_privilege('anon', 'public.is_financial_crew_of(uuid)', 'EXECUTE');
