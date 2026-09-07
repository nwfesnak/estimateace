-- ============================================================================
-- EstimateAce — RLS audit / enable (run in Supabase SQL Editor)
-- Confirms RLS is on for tenant tables. Safe to re-run.
-- ============================================================================

-- Core docs
ALTER TABLE IF EXISTS public.estimates ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public."archive-est" ENABLE ROW LEVEL SECURITY;

-- Billing / payments
ALTER TABLE IF EXISTS public.subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.payment_accounts ENABLE ROW LEVEL SECURITY;

-- Crew
ALTER TABLE IF EXISTS public.crew_members ENABLE ROW LEVEL SECURITY;

-- SMS consent (server/service-role writes; no public anon policies needed)
ALTER TABLE IF EXISTS public.sms_opt_ins ENABLE ROW LEVEL SECURITY;

-- Report which tables have RLS enabled
SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
  AND c.relname IN (
    'estimates',
    'archive-est',
    'subscriptions',
    'payment_accounts',
    'crew_members',
    'sms_opt_ins',
    'login_otp',
    'crew_seat_subscriptions'
  )
ORDER BY 1;

-- List policies (review in Dashboard → Authentication is not enough; use this)
SELECT schemaname, tablename, policyname, cmd, roles
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN (
    'estimates',
    'archive-est',
    'subscriptions',
    'payment_accounts',
    'crew_members',
    'sms_opt_ins'
  )
ORDER BY tablename, policyname;
