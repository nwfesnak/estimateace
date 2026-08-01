-- =============================================================================
-- SIMPLE ARCHIVES TABLE (fixes 400 on archive-est)
-- Run on Supabase project: jiujzujkednnkjymawdk
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.archives (
  id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  archived_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_archives_user_id ON public.archives(user_id);
CREATE INDEX IF NOT EXISTS idx_archives_archived_at ON public.archives(archived_at DESC);

ALTER TABLE public.archives ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own archives" ON public.archives;
DROP POLICY IF EXISTS "Users can insert own archives" ON public.archives;
DROP POLICY IF EXISTS "Users can update own archives" ON public.archives;
DROP POLICY IF EXISTS "Users can delete own archives" ON public.archives;

CREATE POLICY "Users can view own archives"
ON public.archives FOR SELECT TO authenticated
USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own archives"
ON public.archives FOR INSERT TO authenticated
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own archives"
ON public.archives FOR UPDATE TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own archives"
ON public.archives FOR DELETE TO authenticated
USING (auth.uid() = user_id);

-- Optional flag on estimates (used only as last-resort fallback)
ALTER TABLE public.estimates ADD COLUMN IF NOT EXISTS archived boolean DEFAULT false;
ALTER TABLE public.estimates ADD COLUMN IF NOT EXISTS archived_at timestamptz;

NOTIFY pgrst, 'reload schema';

-- Verify:
-- SELECT * FROM public.archives LIMIT 1;
