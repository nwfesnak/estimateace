-- Read-only checks after applying supabase/crew-security-gaps-2026-11.sql.
-- Safe to run in the SQL Editor. Does not modify data.
-- Expected results are in comments.

-- 1. Crew cannot SELECT SETTINGS rows (policy forbids the id prefix).
SELECT policyname, cmd, qual
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename = 'estimates'
  AND policyname ILIKE 'Crew can %'
ORDER BY cmd, policyname;
-- Expect: SELECT/INSERT/UPDATE only (no DELETE).
-- SELECT qual includes "id NOT LIKE 'SETTINGS-%'" and does not grant
-- "id = 'SETTINGS-' || user_id".

-- 2. Archive policies require full data access + reports tab.
SELECT policyname, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename = 'archive-est'
  AND policyname ILIKE 'Crew can %'
ORDER BY cmd;
-- Expect: no DELETE. SELECT/INSERT/UPDATE use is_full_access_crew_of AND crew_has_tab(..., 'reports').

-- 3. Letterhead RPC exists; anon cannot call it.
SELECT
  p.proname,
  has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_execute,
  has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_execute
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
    'crew_company_display',
    'is_crew_of',
    'is_full_access_crew_of',
    'is_financial_crew_of',
    'crew_has_tab'
  )
ORDER BY p.proname;
-- Expect: anon_execute = false for all; authenticated_execute = true.

-- 4. Storage upload allow-list includes line-photo; no crew DELETE.
SELECT policyname, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'storage'
  AND policyname ILIKE 'Crew can %'
ORDER BY cmd, policyname;
-- Expect: 3 rows (SELECT, INSERT, UPDATE). INSERT with_check contains 'line-photo'.
-- No DELETE policy.

-- 5. Helper: media_kind('uuid/line-photo/file.jpg') = 'line-photo'
SELECT public.media_kind('00000000-0000-0000-0000-000000000000/line-photo/abc.jpg') AS kind;
-- Expect: line-photo
