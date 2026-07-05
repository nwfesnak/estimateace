-- ============================================================================
-- ESTIMATEACE - REQUIRED DATABASE SCHEMA
-- ============================================================================
-- Run this in Supabase SQL Editor before using the app in production.
-- This creates the minimal tables the app expects.
--
-- After running:
-- 1. Enable RLS on both tables (see rls-policies.sql)
-- 2. Create 'media' storage bucket (public or private depending on your RLS)
-- 3. Apply the policies from rls-policies.sql
-- ============================================================================

-- Main documents table (estimates + invoices)
CREATE TABLE IF NOT EXISTS public.estimates (
  id TEXT PRIMARY KEY,                    -- e.g. EST-0001 or INV-0001
  user_id UUID REFERENCES auth.users(id) NOT NULL,
  
  -- Document metadata
  documentType TEXT DEFAULT 'estimate',   -- 'estimate' | 'invoice'
  jobName TEXT,
  address TEXT,
  city TEXT,
  state TEXT,
  zipCode TEXT,
  phones TEXT[],
  emails TEXT[],
  date TEXT,
  invoiceNumber TEXT,
  
  -- Line items and calculations (stored as JSONB for flexibility)
  items JSONB DEFAULT '[]'::jsonb,
  terms TEXT,
  laborHours NUMERIC DEFAULT 0,
  laborRate NUMERIC DEFAULT 0,
  laborFixedAmount NUMERIC DEFAULT 0,
  useHourlyLabor BOOLEAN DEFAULT true,
  laborAmount NUMERIC,
  taxRate NUMERIC,
  taxAmount NUMERIC,
  isTaxExempt BOOLEAN DEFAULT false,
  taxLabor BOOLEAN DEFAULT true,

  -- Discount (optional — only shown to clients when filled in)
  discountDescription TEXT,
  discountValue NUMERIC DEFAULT 0,
  discountType TEXT DEFAULT 'dollar',
  discountAmount NUMERIC DEFAULT 0,
  
  -- Media
  photoUrls TEXT[] DEFAULT '{}',
  videoUrls TEXT[] DEFAULT '{}',
  receiptUrls TEXT[] DEFAULT '{}',
  receiptDetails JSONB DEFAULT '[]'::jsonb,
  
  -- Payments / status
  dueDate TEXT,
  paymentStatus TEXT DEFAULT 'pending',
  amountPaid NUMERIC DEFAULT 0,
  paymentMethod TEXT,
  
  -- Snapshot of company profile at time of creation (includes logo, terms, teammates, etc.)
  profile JSONB,
  
  -- Timestamps
  updated_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Archive table (same structure + archive metadata)
CREATE TABLE IF NOT EXISTS public."archive-est" (
  id TEXT PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) NOT NULL,
  documentType TEXT,
  jobName TEXT,
  address TEXT,
  city TEXT,
  state TEXT,
  zipCode TEXT,
  phones TEXT[],
  emails TEXT[],
  date TEXT,
  invoiceNumber TEXT,
  items JSONB,
  terms TEXT,
  laborHours NUMERIC,
  laborRate NUMERIC,
  laborFixedAmount NUMERIC,
  useHourlyLabor BOOLEAN,
  laborAmount NUMERIC,
  taxRate NUMERIC,
  taxAmount NUMERIC,
  isTaxExempt BOOLEAN,
  taxLabor BOOLEAN,
  photoUrls TEXT[],
  videoUrls TEXT[],
  receiptUrls TEXT[],
  receiptDetails JSONB,
  dueDate TEXT,
  paymentStatus TEXT,
  amountPaid NUMERIC,
  paymentMethod TEXT,
  profile JSONB,
  updated_at TIMESTAMPTZ,
  archived_at TIMESTAMPTZ DEFAULT now()
);

-- Recommended indexes
CREATE INDEX IF NOT EXISTS idx_estimates_user_id ON public.estimates(user_id);
CREATE INDEX IF NOT EXISTS idx_estimates_updated ON public.estimates(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_archive_user_id ON public."archive-est"(user_id);

-- Enable RLS (do this explicitly if not done by policy script)
-- ALTER TABLE public.estimates ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE public."archive-est" ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.estimates IS 'Stores all estimates and invoices. profile column contains snapshot of company data (including potentially sensitive crew info in demo).';
COMMENT ON TABLE public."archive-est" IS 'Archived documents. Same structure as estimates.';
