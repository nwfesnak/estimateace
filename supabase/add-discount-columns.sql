-- Optional: run in Supabase SQL Editor if you want dedicated discount columns.
-- The app stores discount data in profile._discount JSONB by default (no migration required).

ALTER TABLE public.estimates ADD COLUMN IF NOT EXISTS discountDescription TEXT;
ALTER TABLE public.estimates ADD COLUMN IF NOT EXISTS discountValue NUMERIC DEFAULT 0;
ALTER TABLE public.estimates ADD COLUMN IF NOT EXISTS discountType TEXT DEFAULT 'dollar';
ALTER TABLE public.estimates ADD COLUMN IF NOT EXISTS discountAmount NUMERIC DEFAULT 0;