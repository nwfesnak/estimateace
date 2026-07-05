-- ============================================================================
-- ESTIMATEACE - BASIC ROW LEVEL SECURITY (RLS) POLICIES
-- ============================================================================
-- Run these in the Supabase SQL Editor (Dashboard > SQL Editor > New query)
--
-- IMPORTANT:
-- 1. Make sure you have created the tables:
--    - estimates (with user_id uuid, ... other columns)
--    - archive-est (similar)
--
-- 2. Enable RLS on the tables:
--    ALTER TABLE estimates ENABLE ROW LEVEL SECURITY;
--    ALTER TABLE "archive-est" ENABLE ROW LEVEL SECURITY;
--
-- 3. For Storage: Go to Storage > Policies for the 'media' bucket.
--
-- 4. After applying, TEST thoroughly with different users.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- TABLE: estimates
-- ----------------------------------------------------------------------------

-- Users can SELECT only their own rows
CREATE POLICY "Users can view their own estimates"
ON estimates
FOR SELECT
TO authenticated
USING (auth.uid() = user_id);

-- Users can INSERT only if user_id matches their auth.uid()
CREATE POLICY "Users can insert their own estimates"
ON estimates
FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = user_id);

-- Users can UPDATE only their own rows
CREATE POLICY "Users can update their own estimates"
ON estimates
FOR UPDATE
TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

-- Users can DELETE only their own rows
CREATE POLICY "Users can delete their own estimates"
ON estimates
FOR DELETE
TO authenticated
USING (auth.uid() = user_id);

-- ----------------------------------------------------------------------------
-- TABLE: archive-est
-- ----------------------------------------------------------------------------

CREATE POLICY "Users can view their own archived estimates"
ON "archive-est"
FOR SELECT
TO authenticated
USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own archived estimates"
ON "archive-est"
FOR INSERT
TO authenticated
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own archived estimates"
ON "archive-est"
FOR UPDATE
TO authenticated
USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own archived estimates"
ON "archive-est"
FOR DELETE
TO authenticated
USING (auth.uid() = user_id);

-- ----------------------------------------------------------------------------
-- STORAGE POLICIES for 'media' bucket (apply in Dashboard > Storage > Policies)
-- ----------------------------------------------------------------------------
-- These are examples. Create them via the UI or SQL if using storage policies table.

-- For storage policies, use the dedicated file:
-- supabase/storage-policies.sql
-- 
-- It contains clean, runnable SQL for creating the 4 policies.
-- 
-- Or copy the expressions below for the UI:
-- 
-- When adding a policy in the Storage > media > Policies UI:
--   - For the "Policy" / expression field, use exactly:
--     (bucket_id = 'media'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text)
--
-- Example for INSERT:
-- Policy name: Users can upload their own media
-- Operation: INSERT
-- Using / With check: (bucket_id = 'media'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text)
--
-- Do the same for SELECT, UPDATE, DELETE.

-- ----------------------------------------------------------------------------
-- NOTES
-- ----------------------------------------------------------------------------
-- - These policies assume the 'user_id' column stores auth.uid() (the Supabase auth user ID).
-- - Crew/subcontractor access currently impersonates the owner user_id.
--   For true multi-user security, consider separate auth accounts or proper RLS for crew.
-- - Always test with the "Test RLS" feature or different logged-in users in Supabase.
-- - For production, also enable "Leaked password protection" and email confirmations in Auth settings.
-- ============================================================================
