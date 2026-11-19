-- ============================================================================
-- EstimateAce — security hardening (2026-11)
-- Fixes from the Nov 19 audit: C1, C2, H1, H2, M1, M2, M5.
--
-- Run ONCE in the Supabase SQL Editor (production project jiujzujkednnkjymawdk)
-- right BEFORE the matching app deploy goes live. Safe to re-run (idempotent).
-- Runs in one transaction: if any step fails, nothing changes.
--
-- What it does
--   1. receptionist_accounts  (NEW, server-only)
--        Holds the AI Receptionist entitlement (Stripe add-on billing) and the
--        Twilio line + subaccount auth token. RLS on, no policies, and no grants
--        to anon/authenticated, so only the server (service role) can read/write.
--        Existing data is COPIED in from the SETTINGS-<uid> and
--        RECEPTIONIST-SECRETS-<uid> rows of public.estimates. After the copy is
--        verified, the RECEPTIONIST-SECRETS-<uid> rows (readable by the user and
--        their crew) are removed. Nothing else in estimates is touched.
--   2. estimates reserved-id guard (trigger)
--        Signed-in users (REST API) can no longer:
--          * create/claim another account's SETTINGS-<uid> row,
--          * write RECEPTIONIST-SECRETS-* or PLATFORM-* rows,
--          * change a row's id or move a row to another user_id.
--        The server (service role) and the SQL editor are unaffected.
--   3. Crew tables read-only for owners
--        crew_members / crew_seat_subscriptions: owners (and crew, for their own
--        membership) can only SELECT. All writes go through the server API, which
--        activates seats only from Stripe.
--   4. rate_limit_counters + rate_limit_hit()  (NEW, server-only)
--        Shared, persistent fixed-window rate limiting / daily quotas used by the
--        app for SMS, email, the public opt-in form, 2-step codes and the
--        marketing chat (replaces per-instance in-memory counters).
--   5. login_otp, sms_opt_ins  (create if missing; both were missing in prod)
--        Server-only tables for SMS 2-step codes and the A2P consent log.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. receptionist_accounts
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.receptionist_accounts (
  user_id               UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  billing               JSONB NOT NULL DEFAULT '{}'::jsonb,  -- mirror of the Stripe add-on subscription
  phone_number          TEXT,                                -- E.164 Twilio line (unique)
  subaccount_sid        TEXT,
  number_sid            TEXT,
  subaccount_auth_token TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS receptionist_accounts_phone_unique
  ON public.receptionist_accounts (phone_number)
  WHERE phone_number IS NOT NULL AND phone_number <> '';

ALTER TABLE public.receptionist_accounts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.receptionist_accounts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.receptionist_accounts TO service_role;

COMMENT ON TABLE public.receptionist_accounts IS
  'Server-only: AI Receptionist entitlement + Twilio line/secrets. No client access.';

-- 1a. Seed one row per user that has receptionist data (SETTINGS or SECRETS row).
WITH settings AS (
  SELECT e.user_id,
         CASE WHEN jsonb_typeof(e.profile->'receptionistBilling') = 'object'
              THEN e.profile->'receptionistBilling' ELSE '{}'::jsonb END            AS billing,
         NULLIF(trim(e.profile #>> '{receptionistConfig,twilio,phoneNumber}'), '')   AS cfg_phone,
         NULLIF(trim(e.profile #>> '{receptionistConfig,twilio,subaccountSid}'), '') AS cfg_sub,
         NULLIF(trim(e.profile #>> '{receptionistConfig,twilio,numberSid}'), '')     AS cfg_num
  FROM public.estimates e
  WHERE e.id = 'SETTINGS-' || e.user_id::text
),
secrets AS (
  SELECT e.user_id,
         NULLIF(trim(e.profile->>'phoneNumber'), '')         AS phone,
         NULLIF(trim(e.profile->>'subaccountSid'), '')       AS sub,
         NULLIF(trim(e.profile->>'numberSid'), '')           AS num,
         NULLIF(trim(e.profile->>'subaccountAuthToken'), '') AS token
  FROM public.estimates e
  WHERE e.id = 'RECEPTIONIST-SECRETS-' || e.user_id::text
),
merged AS (
  SELECT coalesce(s.user_id, x.user_id)              AS user_id,
         coalesce(s.billing, '{}'::jsonb)            AS billing,
         coalesce(x.phone, s.cfg_phone)              AS phone,
         coalesce(x.sub, s.cfg_sub)                  AS sub,
         coalesce(x.num, s.cfg_num)                  AS num,
         x.token                                     AS token,
         (x.user_id IS NOT NULL)                     AS from_secrets
  FROM settings s
  FULL OUTER JOIN secrets x ON x.user_id = s.user_id
  WHERE (s.billing IS NOT NULL AND s.billing <> '{}'::jsonb)
     OR coalesce(x.phone, s.cfg_phone) IS NOT NULL
     OR x.token IS NOT NULL
),
-- If two accounts ever claimed the same number, keep it only on one
-- (prefer the account whose server-written SECRETS row has it).
ranked AS (
  SELECT m.*,
         row_number() OVER (PARTITION BY m.phone ORDER BY m.from_secrets DESC, m.user_id) AS rn
  FROM merged m
)
INSERT INTO public.receptionist_accounts AS ra
  (user_id, billing, phone_number, subaccount_sid, number_sid, subaccount_auth_token)
SELECT r.user_id,
       r.billing,
       CASE
         WHEN r.phone IS NOT NULL
          AND r.rn = 1
          AND NOT EXISTS (
            SELECT 1 FROM public.receptionist_accounts r2
            WHERE r2.phone_number = r.phone AND r2.user_id <> r.user_id
          )
         THEN r.phone
         ELSE NULL
       END,
       r.sub, r.num, r.token
FROM ranked r
ON CONFLICT (user_id) DO UPDATE SET
  -- Re-runs never overwrite values the server has written since.
  billing               = CASE WHEN ra.billing = '{}'::jsonb THEN EXCLUDED.billing ELSE ra.billing END,
  phone_number          = coalesce(ra.phone_number, EXCLUDED.phone_number),
  subaccount_sid        = coalesce(ra.subaccount_sid, EXCLUDED.subaccount_sid),
  number_sid            = coalesce(ra.number_sid, EXCLUDED.number_sid),
  subaccount_auth_token = coalesce(ra.subaccount_auth_token, EXCLUDED.subaccount_auth_token),
  updated_at            = now();

-- 1b. Remove the client-readable secrets rows, but only where the token is safely
--     copied (or there was no token to copy).
DELETE FROM public.estimates e
WHERE e.id = 'RECEPTIONIST-SECRETS-' || e.user_id::text
  AND EXISTS (
    SELECT 1 FROM public.receptionist_accounts ra
    WHERE ra.user_id = e.user_id
      AND (
        NULLIF(trim(e.profile->>'subaccountAuthToken'), '') IS NULL
        OR ra.subaccount_auth_token = trim(e.profile->>'subaccountAuthToken')
      )
  );

-- ---------------------------------------------------------------------------
-- 2. estimates: reserved-id / ownership guard for signed-in (REST) writes
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
-- 3. Crew tables: read-only for signed-in users
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Owners manage crew_members" ON public.crew_members;
DROP POLICY IF EXISTS "Owners read crew_members" ON public.crew_members;
CREATE POLICY "Owners read crew_members" ON public.crew_members
  FOR SELECT TO authenticated
  USING (auth.uid() = owner_user_id);
-- "Crew can read own membership" (SELECT) is kept as-is.

DROP POLICY IF EXISTS "Owners manage crew_seat_subscriptions" ON public.crew_seat_subscriptions;
DROP POLICY IF EXISTS "Owners read crew_seat_subscriptions" ON public.crew_seat_subscriptions;
CREATE POLICY "Owners read crew_seat_subscriptions" ON public.crew_seat_subscriptions
  FOR SELECT TO authenticated
  USING (auth.uid() = owner_user_id);

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.crew_members FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.crew_seat_subscriptions FROM anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Shared rate limiting
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.rate_limit_counters (
  bucket       TEXT        NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  hits         INTEGER     NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);
ALTER TABLE public.rate_limit_counters ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.rate_limit_counters FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.rate_limit_counters TO service_role;

-- Atomically add p_cost hits to the current fixed window for p_bucket and report
-- whether the caller is still within p_max.
CREATE OR REPLACE FUNCTION public.rate_limit_hit(
  p_bucket TEXT,
  p_window_seconds INTEGER,
  p_max INTEGER,
  p_cost INTEGER DEFAULT 1
)
RETURNS TABLE (allowed BOOLEAN, used INTEGER, reset_at TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_window INTEGER := greatest(1, p_window_seconds);
  v_start  TIMESTAMPTZ := to_timestamp(floor(extract(epoch FROM now()) / v_window) * v_window);
  v_hits   INTEGER;
BEGIN
  INSERT INTO public.rate_limit_counters AS c (bucket, window_start, hits)
  VALUES (p_bucket, v_start, greatest(0, p_cost))
  ON CONFLICT (bucket, window_start)
  DO UPDATE SET hits = c.hits + greatest(0, EXCLUDED.hits)
  RETURNING c.hits INTO v_hits;

  -- Opportunistic cleanup of old windows (longest window used is 1 day).
  IF random() < 0.02 THEN
    DELETE FROM public.rate_limit_counters WHERE window_start < now() - interval '3 days';
  END IF;

  RETURN QUERY SELECT (v_hits <= p_max), v_hits, v_start + make_interval(secs => v_window);
END;
$$;

REVOKE ALL ON FUNCTION public.rate_limit_hit(TEXT, INTEGER, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rate_limit_hit(TEXT, INTEGER, INTEGER, INTEGER) TO service_role;

-- ---------------------------------------------------------------------------
-- 5. login_otp + sms_opt_ins (server-only)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.login_otp (
  user_id    UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  code_hash  TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  attempts   INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.login_otp ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.login_otp FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.login_otp TO service_role;

CREATE TABLE IF NOT EXISTS public.sms_opt_ins (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone        TEXT NOT NULL,
  opted_in     BOOLEAN NOT NULL DEFAULT true,
  method       TEXT NOT NULL DEFAULT 'web_form',
  source       TEXT,
  ip           TEXT,
  user_agent   TEXT,
  confirmed_at TIMESTAMPTZ,
  opted_out_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS sms_opt_ins_phone_unique ON public.sms_opt_ins (phone);
ALTER TABLE public.sms_opt_ins ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sms_opt_ins FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sms_opt_ins TO service_role;

COMMIT;

-- Quick check after running (expect: rows copied, 0 secrets rows left):
--   SELECT count(*) AS receptionist_accounts,
--          count(*) FILTER (WHERE subaccount_auth_token IS NOT NULL) AS with_token
--   FROM public.receptionist_accounts;
--   SELECT count(*) AS leftover_secret_rows FROM public.estimates
--   WHERE id LIKE 'RECEPTIONIST-SECRETS-%';
