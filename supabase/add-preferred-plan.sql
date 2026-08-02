-- Optional: store plan chosen at trial signup (monthly | yearly)
ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS preferred_plan TEXT;
