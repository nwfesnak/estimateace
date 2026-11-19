-- ============================================================================
-- EstimateAce — security hardening, part 2 (2026-11, second scan)
-- Run ONCE in the Supabase SQL Editor (production project jiujzujkednnkjymawdk)
-- BEFORE the matching app deploy goes live. Safe to re-run (idempotent).
-- Runs in one transaction: if any step fails, nothing changes. No rows are deleted.
--
-- What it does
--   1. subscriptions: new server-only columns
--        account_closes_at / deletion_requested_at   (scheduled account deletion)
--        welcome_onboarding_sent_at / owner_signup_alert_sent_at  (one-time sends)
--      Users and crew can only SELECT subscriptions (no write policies), so these
--      cannot be set or reset from the browser. Existing values are copied in from the
--      SETTINGS-<uid> rows (accountClosesAt, deletionRequestedAt,
--      welcomeOnboardingSentAt, ownerSignupAlertSentAt); the SETTINGS copies are left
--      in place as display-only mirrors.
--   2. estimates guard trigger: only the account owner may create/change their own
--      SETTINGS-<uid> row. Crew (and anyone else) can no longer edit the owner's
--      company settings, payment instructions or close date.
--   3. Crew can no longer DELETE the owner's documents or archives (owner-only).
--      Crew keep read / create / edit access exactly as before.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. subscriptions: server-only close date + one-time send markers
-- ---------------------------------------------------------------------------
ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS account_closes_at          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deletion_requested_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS welcome_onboarding_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS owner_signup_alert_sent_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS subscriptions_account_closes_at_idx
  ON public.subscriptions (account_closes_at)
  WHERE account_closes_at IS NOT NULL;

-- Tolerant text -> timestamptz (bad / empty values become NULL instead of failing).
CREATE OR REPLACE FUNCTION pg_temp.ea_try_ts(v TEXT)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
AS $$
BEGIN
  IF v IS NULL OR btrim(v) = '' THEN
    RETURN NULL;
  END IF;
  RETURN v::timestamptz;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$;

-- 1a. Copy values from SETTINGS rows. Never overwrites a value already set on
--     subscriptions (re-runs are no-ops).
WITH s AS (
  SELECT e.user_id,
         pg_temp.ea_try_ts(e.profile->>'accountClosesAt')         AS closes_at,
         pg_temp.ea_try_ts(e.profile->>'deletionRequestedAt')     AS requested_at,
         pg_temp.ea_try_ts(e.profile->>'welcomeOnboardingSentAt') AS welcome_at,
         pg_temp.ea_try_ts(e.profile->>'ownerSignupAlertSentAt')  AS alert_at
  FROM public.estimates e
  WHERE e.id = 'SETTINGS-' || e.user_id::text
)
UPDATE public.subscriptions sub
SET account_closes_at          = coalesce(sub.account_closes_at, s.closes_at),
    deletion_requested_at      = coalesce(sub.deletion_requested_at, s.requested_at),
    welcome_onboarding_sent_at = coalesce(sub.welcome_onboarding_sent_at, s.welcome_at),
    owner_signup_alert_sent_at = coalesce(sub.owner_signup_alert_sent_at, s.alert_at)
FROM s
WHERE sub.user_id = s.user_id
  AND (   (sub.account_closes_at          IS NULL AND s.closes_at    IS NOT NULL)
       OR (sub.deletion_requested_at      IS NULL AND s.requested_at IS NOT NULL)
       OR (sub.welcome_onboarding_sent_at IS NULL AND s.welcome_at   IS NOT NULL)
       OR (sub.owner_signup_alert_sent_at IS NULL AND s.alert_at     IS NOT NULL));

-- 1b. Accounts that scheduled deletion but have no subscriptions row yet
--     (the old code fell back to SETTINGS when the columns were missing).
INSERT INTO public.subscriptions
  (user_id, status, cancel_at_period_end, account_closes_at, deletion_requested_at,
   welcome_onboarding_sent_at, owner_signup_alert_sent_at)
SELECT e.user_id,
       'canceled',
       true,
       pg_temp.ea_try_ts(e.profile->>'accountClosesAt'),
       pg_temp.ea_try_ts(e.profile->>'deletionRequestedAt'),
       pg_temp.ea_try_ts(e.profile->>'welcomeOnboardingSentAt'),
       pg_temp.ea_try_ts(e.profile->>'ownerSignupAlertSentAt')
FROM public.estimates e
WHERE e.id = 'SETTINGS-' || e.user_id::text
  AND pg_temp.ea_try_ts(e.profile->>'accountClosesAt') IS NOT NULL
  AND EXISTS (SELECT 1 FROM auth.users u WHERE u.id = e.user_id)
  AND NOT EXISTS (SELECT 1 FROM public.subscriptions s2 WHERE s2.user_id = e.user_id)
ON CONFLICT (user_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. estimates guard: SETTINGS-<uid> is owner-only
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.estimates_guard_reserved_ids()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- Only police client roles; service_role / postgres (server, SQL editor) pass.
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id THEN
      RAISE EXCEPTION 'Document id cannot be changed' USING ERRCODE = '42501';
    END IF;
    IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
      RAISE EXCEPTION 'Document owner cannot be changed' USING ERRCODE = '42501';
    END IF;
  END IF;

  IF NEW.id LIKE 'SETTINGS-%' AND NEW.id <> 'SETTINGS-' || NEW.user_id::text THEN
    RAISE EXCEPTION 'Reserved settings id' USING ERRCODE = '42501';
  END IF;

  -- Workspace settings (company profile, payment instructions, close date mirror)
  -- may only be written by the account owner themself, never by crew.
  IF NEW.id = 'SETTINGS-' || NEW.user_id::text
     AND auth.uid() IS DISTINCT FROM NEW.user_id THEN
    RAISE EXCEPTION 'Only the account owner can change workspace settings'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.id LIKE 'RECEPTIONIST-SECRETS-%' OR NEW.id LIKE 'PLATFORM-%' THEN
    RAISE EXCEPTION 'Reserved id' USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS estimates_guard_reserved_ids ON public.estimates;
CREATE TRIGGER estimates_guard_reserved_ids
  BEFORE INSERT OR UPDATE ON public.estimates
  FOR EACH ROW EXECUTE FUNCTION public.estimates_guard_reserved_ids();

-- ---------------------------------------------------------------------------
-- 3. Deletes are owner-only (crew keep view / insert / update)
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Crew can delete owner estimates" ON public.estimates;
DROP POLICY IF EXISTS "Crew can delete owner archives" ON public."archive-est";

COMMIT;

-- Verification (run after):
--   SELECT column_name FROM information_schema.columns
--   WHERE table_schema='public' AND table_name='subscriptions'
--     AND column_name IN ('account_closes_at','deletion_requested_at',
--                         'welcome_onboarding_sent_at','owner_signup_alert_sent_at');
--   SELECT policyname, cmd FROM pg_policies
--   WHERE tablename IN ('estimates','archive-est') AND policyname ILIKE '%crew%';
--     -- expect no DELETE rows
--   SELECT count(*) FILTER (WHERE account_closes_at IS NOT NULL) AS closing,
--          count(*) FILTER (WHERE account_closes_at <= now())     AS due_for_purge
--   FROM public.subscriptions;
--     -- review due_for_purge BEFORE the daily purge cron runs (08:00 UTC)
