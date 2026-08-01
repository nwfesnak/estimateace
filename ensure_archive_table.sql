-- Run this on the MAIN Supabase project (jiujzujkednnkjymawdk)
-- Creates archive-est with lowercase columns (works with the app's lowercase insert fallback)

CREATE TABLE IF NOT EXISTS public."archive-est" (
  id TEXT PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) NOT NULL,
  documenttype TEXT,
  jobname TEXT,
  address TEXT,
  city TEXT,
  state TEXT,
  zipcode TEXT,
  phones TEXT[],
  emails TEXT[],
  date TEXT,
  invoicenumber TEXT,
  items JSONB DEFAULT '[]'::jsonb,
  terms TEXT,
  laborhours NUMERIC,
  laborrate NUMERIC,
  laborfixedamount NUMERIC,
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
  profile JSONB DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ DEFAULT now(),
  archived_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_archive_user_id ON public."archive-est"(user_id);

ALTER TABLE public."archive-est" ENABLE ROW LEVEL SECURITY;

-- Drop old policies if re-running (ignore errors if they don't exist)
DROP POLICY IF EXISTS "Users can view their own archived estimates" ON public."archive-est";
DROP POLICY IF EXISTS "Users can insert their own archived estimates" ON public."archive-est";
DROP POLICY IF EXISTS "Users can update their own archived estimates" ON public."archive-est";
DROP POLICY IF EXISTS "Users can delete their own archived estimates" ON public."archive-est";

CREATE POLICY "Users can view their own archived estimates"
ON public."archive-est" FOR SELECT TO authenticated
USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own archived estimates"
ON public."archive-est" FOR INSERT TO authenticated
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own archived estimates"
ON public."archive-est" FOR UPDATE TO authenticated
USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete their own archived estimates"
ON public."archive-est" FOR DELETE TO authenticated
USING (auth.uid() = user_id);

-- Reload schema cache
NOTIFY pgrst, 'reload schema';
