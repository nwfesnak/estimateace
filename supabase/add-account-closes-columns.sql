-- Run once if subscriptions table already exists without these columns
ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS account_closes_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deletion_requested_at TIMESTAMPTZ;
