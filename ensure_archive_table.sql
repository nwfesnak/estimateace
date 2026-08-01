-- =============================================================================
-- FIX archive-est for MAIN Supabase project (jiujzujkednnkjymawdk)
-- Run this entire script in Supabase SQL Editor, then try Archive again.
-- =============================================================================

-- Drop and recreate clean archive table (SAFE for beta if you can lose old archive rows).
-- If you have important archived data, do NOT run the DROP — contact support / skip to ALTERs.

DROP TABLE IF EXISTS public."archive-est" CASCADE;

CREATE TABLE public."archive-est" (
  id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  documenttype TEXT DEFAULT 'estimate',
  jobname TEXT,
  address TEXT,
  city TEXT,
  state TEXT,
  zipcode TEXT,
  phones TEXT[] DEFAULT '{}',
  emails TEXT[] DEFAULT '{}',
  date TEXT,
  invoicenumber TEXT,
  items JSONB DEFAULT '[]'::jsonb,
  terms TEXT,
  laborhours NUMERIC DEFAULT 0,
  laborrate NUMERIC DEFAULT 0,
  laborfixedamount NUMERIC DEFAULT 0,
  usehourlylabor BOOLEAN DEFAULT true,
  laboramount NUMERIC DEFAULT 0,
  taxrate NUMERIC DEFAULT 0,
  taxamount NUMERIC DEFAULT 0,
  istaxexempt BOOLEAN DEFAULT false,
  taxlabor BOOLEAN DEFAULT true,
  photourls TEXT[] DEFAULT '{}',
  videourls TEXT[] DEFAULT '{}',
  receipturls TEXT[] DEFAULT '{}',
  receiptdetails JSONB DEFAULT '[]'::jsonb,
  duedate TEXT,
  paymentstatus TEXT DEFAULT 'pending',
  amountpaid NUMERIC DEFAULT 0,
  paymentmethod TEXT,
  profile JSONB DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ DEFAULT now(),
  archived_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_archive_user_id ON public."archive-est"(user_id);
CREATE INDEX idx_archive_archived_at ON public."archive-est"(archived_at DESC);

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

-- Allow service role full access if needed (optional)
-- GRANT ALL ON public."archive-est" TO authenticated;

NOTIFY pgrst, 'reload schema';

-- Verify:
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'archive-est' ORDER BY ordinal_position;
