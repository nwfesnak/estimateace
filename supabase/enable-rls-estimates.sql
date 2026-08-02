-- ============================================================================
-- CRITICAL: Enable Row Level Security so accounts cannot see each other's data
-- Run in Supabase → SQL Editor → New query → Run
-- ============================================================================

ALTER TABLE public.estimates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."archive-est" ENABLE ROW LEVEL SECURITY;

-- Owner policies (safe to re-run)
DROP POLICY IF EXISTS "Users can view their own estimates" ON public.estimates;
CREATE POLICY "Users can view their own estimates"
  ON public.estimates FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert their own estimates" ON public.estimates;
CREATE POLICY "Users can insert their own estimates"
  ON public.estimates FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update their own estimates" ON public.estimates;
CREATE POLICY "Users can update their own estimates"
  ON public.estimates FOR UPDATE TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete their own estimates" ON public.estimates;
CREATE POLICY "Users can delete their own estimates"
  ON public.estimates FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can view their own archived estimates" ON public."archive-est";
CREATE POLICY "Users can view their own archived estimates"
  ON public."archive-est" FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert their own archived estimates" ON public."archive-est";
CREATE POLICY "Users can insert their own archived estimates"
  ON public."archive-est" FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update their own archived estimates" ON public."archive-est";
CREATE POLICY "Users can update their own archived estimates"
  ON public."archive-est" FOR UPDATE TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete their own archived estimates" ON public."archive-est";
CREATE POLICY "Users can delete their own archived estimates"
  ON public."archive-est" FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

-- Verify (should show rowsecurity = true)
SELECT relname, relrowsecurity
FROM pg_class
WHERE relname IN ('estimates', 'archive-est');
