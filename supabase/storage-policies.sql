-- ============================================================================
-- STORAGE POLICIES FOR "media" BUCKET (Private Recommended)
-- ============================================================================
-- 
-- INSTRUCTIONS:
-- 1. First create the bucket named "media" in Storage (make it Private)
-- 2. Go to SQL Editor → New query
-- 3. Paste and run this entire script
-- 4. Then go back to Storage → media bucket → Policies tab to verify
--
-- These policies ensure:
-- - Users can only upload to their own folder: {user_id}/...
-- - Users can only read/update/delete their own files
-- - Works perfectly with the app's signed URLs (createSignedUrl)
-- ============================================================================

-- Make sure RLS is enabled for storage (usually is by default)
-- ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

-- 1. Allow users to UPLOAD (INSERT) their own files
CREATE POLICY "Users can upload their own media"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  (bucket_id = 'media'::text)
  AND ((storage.foldername(name))[1] = (auth.uid())::text)
);

-- 2. Allow users to VIEW / DOWNLOAD their own files (needed for signed URLs)
CREATE POLICY "Users can view their own media"
ON storage.objects
FOR SELECT
TO authenticated
USING (
  (bucket_id = 'media'::text)
  AND ((storage.foldername(name))[1] = (auth.uid())::text)
);

-- 3. Allow users to UPDATE their own files
CREATE POLICY "Users can update their own media"
ON storage.objects
FOR UPDATE
TO authenticated
USING (
  (bucket_id = 'media'::text)
  AND ((storage.foldername(name))[1] = (auth.uid())::text)
)
WITH CHECK (
  (bucket_id = 'media'::text)
  AND ((storage.foldername(name))[1] = (auth.uid())::text)
);

-- 4. Allow users to DELETE their own files
CREATE POLICY "Users can delete their own media"
ON storage.objects
FOR DELETE
TO authenticated
USING (
  (bucket_id = 'media'::text)
  AND ((storage.foldername(name))[1] = (auth.uid())::text)
);

-- ============================================================================
-- NOTES:
-- - These assume files are uploaded to paths like: {user-uuid}/photo/xxx.jpg
--   The app already does this: `${user.id}/${type}/...`
-- - If you get "policy already exists" error, drop them first or use IF NOT EXISTS (not supported for policies)
-- - Test by uploading a photo in the app after running this.
-- ============================================================================