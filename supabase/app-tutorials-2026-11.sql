-- ============================================================================
-- EstimateAce — Platform video tutorial links (2026-11)
--
-- Apply via Supabase SQL Editor or apply_migration (project jiujzujkednnkjymawdk)
-- at merge time. Do not apply to production until this PR is merged.
-- Idempotent; deletes no rows.
--
-- Global catalog (not company-scoped) of how-to video hyperlinks shown to
-- every signed-in user under Company Profile / Account → Video Tutorials.
-- Writes are performed by the Next.js /api/tutorials route with the service
-- role after a server-side platform-admin email check. Authenticated users
-- may only SELECT.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.app_tutorials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  description TEXT,
  url TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by_email TEXT,
  CONSTRAINT app_tutorials_title_not_blank CHECK (length(btrim(title)) > 0),
  CONSTRAINT app_tutorials_url_http CHECK (lower(url) LIKE 'https://%' OR lower(url) LIKE 'http://%')
);

CREATE INDEX IF NOT EXISTS idx_app_tutorials_sort
  ON public.app_tutorials (sort_order, created_at);

COMMENT ON TABLE public.app_tutorials IS
  'Platform-wide video tutorial links managed by EstimateAce admins. Visible to all signed-in users.';

ALTER TABLE public.app_tutorials ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated users can read app_tutorials" ON public.app_tutorials;
CREATE POLICY "Authenticated users can read app_tutorials"
  ON public.app_tutorials
  FOR SELECT
  TO authenticated
  USING (true);

-- No INSERT/UPDATE/DELETE policies for authenticated or anon.
-- The API writes with the service role after isPlatformAdminEmail().

REVOKE ALL ON TABLE public.app_tutorials FROM PUBLIC;
REVOKE ALL ON TABLE public.app_tutorials FROM anon;
GRANT SELECT ON TABLE public.app_tutorials TO authenticated;
GRANT ALL ON TABLE public.app_tutorials TO service_role;
