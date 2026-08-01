-- =============================================================================
-- FIX archive-est so Archive works (MAIN project: jiujzujkednnkjymawdk)
-- Run this entire script in Supabase → SQL Editor → Run
-- =============================================================================
-- WARNING: This DROPS the existing archive-est table (old archive rows are removed).
-- If you need old archives, export them first.
-- =============================================================================

DROP TABLE IF EXISTS public."archive-est" CASCADE;

-- Columns are QUOTED camelCase so they match the app's insert payload exactly
CREATE TABLE public."archive-est" (
  id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  "documentType" TEXT DEFAULT 'estimate',
  "jobName" TEXT,
  address TEXT,
  city TEXT,
  state TEXT,
  "zipCode" TEXT,
  phones TEXT[] DEFAULT '{}',
  emails TEXT[] DEFAULT '{}',
  date TEXT,
  "invoiceNumber" TEXT,

  items JSONB DEFAULT '[]'::jsonb,
  terms TEXT,

  "laborHours" NUMERIC DEFAULT 0,
  "laborRate" NUMERIC DEFAULT 0,
  "laborFixedAmount" NUMERIC DEFAULT 0,
  "useHourlyLabor" BOOLEAN DEFAULT true,
  "laborAmount" NUMERIC DEFAULT 0,

  "taxRate" NUMERIC DEFAULT 0,
  "taxAmount" NUMERIC DEFAULT 0,
  "isTaxExempt" BOOLEAN DEFAULT false,
  "taxLabor" BOOLEAN DEFAULT true,

  "photoUrls" TEXT[] DEFAULT '{}',
  "videoUrls" TEXT[] DEFAULT '{}',
  "receiptUrls" TEXT[] DEFAULT '{}',
  "receiptDetails" JSONB DEFAULT '[]'::jsonb,

  "dueDate" TEXT,
  "paymentStatus" TEXT DEFAULT 'pending',
  "amountPaid" NUMERIC DEFAULT 0,
  "paymentMethod" TEXT,

  profile JSONB DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ DEFAULT now(),
  archived_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_archive_est_user_id ON public."archive-est"(user_id);
CREATE INDEX idx_archive_est_archived_at ON public."archive-est"(archived_at DESC);

ALTER TABLE public."archive-est" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own archived estimates"
ON public."archive-est" FOR SELECT TO authenticated
USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own archived estimates"
ON public."archive-est" FOR INSERT TO authenticated
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own archived estimates"
ON public."archive-est" FOR UPDATE TO authenticated
USING (auth.uid() = user_id)
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete their own archived estimates"
ON public."archive-est" FOR DELETE TO authenticated
USING (auth.uid() = user_id);

-- Force PostgREST to see the new table/columns
NOTIFY pgrst, 'reload schema';

-- Verify columns (optional):
-- SELECT column_name FROM information_schema.columns
-- WHERE table_name = 'archive-est' ORDER BY ordinal_position;
