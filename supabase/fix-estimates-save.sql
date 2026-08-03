-- ============================================================================
-- Fix estimate saving: ensure table + RLS allow owners to insert/update their rows
-- Run in Supabase → SQL Editor → Run
-- ============================================================================

-- Create table if missing (lowercase columns — works with app's lowercase fallback + API)
CREATE TABLE IF NOT EXISTS public.estimates (
  id TEXT PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) NOT NULL,
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
  laboramount NUMERIC,
  taxrate NUMERIC,
  taxamount NUMERIC,
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
  profile JSONB,
  updated_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.estimates ENABLE ROW LEVEL SECURITY;

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

-- Verify
SELECT count(*) AS estimate_rows FROM public.estimates;
