-- ============================================================================
-- EstimateAce — trial offers (2026-11)
--   * Standard + 2-month trials now require a card (Stripe Checkout); no DB change.
--   * 6-month (and legacy 3-month) card-free offers are capped at 20 signups each.
--
-- The cap is enforced in Postgres so two signups at the same instant can never
-- both take spot #20:
--   - promo_limits holds the cap per promo.
--   - promo_redemptions has one row per (promo, user).
--   - A BEFORE INSERT trigger takes a per-promo advisory lock and refuses the
--     insert once the cap is reached, so even a direct insert cannot exceed it.
--   - claim_promo_spot() is the idempotent entry point the app calls.
-- Service role only: RLS on, no policies, and EXECUTE revoked from anon/authenticated.
--
-- Run in Supabase SQL Editor (production project) BEFORE deploying the app change.
-- Safe to re-run.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.promo_limits (
  promo TEXT PRIMARY KEY,
  max_redemptions INTEGER NOT NULL CHECK (max_redemptions >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO public.promo_limits (promo, max_redemptions)
VALUES ('6mo', 20), ('3mo', 20)
ON CONFLICT (promo) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.promo_redemptions (
  promo TEXT NOT NULL REFERENCES public.promo_limits(promo),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  redeemed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (promo, user_id)
);

ALTER TABLE public.promo_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.promo_redemptions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.promo_limits FROM anon, authenticated;
REVOKE ALL ON public.promo_redemptions FROM anon, authenticated;

-- Cap guard: serialize inserts per promo and reject once full.
CREATE OR REPLACE FUNCTION public.promo_redemptions_enforce_cap()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit INTEGER;
  v_used INTEGER;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('promo_redemptions:' || NEW.promo));
  SELECT max_redemptions INTO v_limit FROM public.promo_limits WHERE promo = NEW.promo;
  IF v_limit IS NULL THEN
    RAISE EXCEPTION 'Unknown promo %', NEW.promo USING ERRCODE = 'check_violation';
  END IF;
  SELECT count(*) INTO v_used FROM public.promo_redemptions WHERE promo = NEW.promo;
  IF v_used >= v_limit THEN
    RAISE EXCEPTION 'Promo % is full (% of % used)', NEW.promo, v_used, v_limit
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS promo_redemptions_cap ON public.promo_redemptions;
CREATE TRIGGER promo_redemptions_cap
  BEFORE INSERT ON public.promo_redemptions
  FOR EACH ROW EXECUTE FUNCTION public.promo_redemptions_enforce_cap();

-- Idempotent claim. Returns whether this user holds a spot and how many are left.
CREATE OR REPLACE FUNCTION public.claim_promo_spot(p_promo TEXT, p_user_id UUID)
RETURNS TABLE (ok BOOLEAN, already BOOLEAN, claimed INTEGER, remaining INTEGER, max_redemptions INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit INTEGER;
  v_used INTEGER;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('promo_redemptions:' || p_promo));
  SELECT l.max_redemptions INTO v_limit FROM public.promo_limits l WHERE l.promo = p_promo;
  IF v_limit IS NULL THEN
    RETURN QUERY SELECT false, false, 0, 0, 0;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.promo_redemptions r WHERE r.promo = p_promo AND r.user_id = p_user_id
  ) THEN
    SELECT count(*) INTO v_used FROM public.promo_redemptions r WHERE r.promo = p_promo;
    RETURN QUERY SELECT true, true, v_used, GREATEST(0, v_limit - v_used), v_limit;
    RETURN;
  END IF;

  SELECT count(*) INTO v_used FROM public.promo_redemptions r WHERE r.promo = p_promo;
  IF v_used >= v_limit THEN
    RETURN QUERY SELECT false, false, v_used, 0, v_limit;
    RETURN;
  END IF;

  INSERT INTO public.promo_redemptions (promo, user_id) VALUES (p_promo, p_user_id);
  v_used := v_used + 1;
  RETURN QUERY SELECT true, false, v_used, GREATEST(0, v_limit - v_used), v_limit;
END;
$$;

-- Read-only counter for the public landing pages.
CREATE OR REPLACE FUNCTION public.promo_spot_status(p_promo TEXT)
RETURNS TABLE (claimed INTEGER, remaining INTEGER, max_redemptions INTEGER)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    (SELECT count(*)::INTEGER FROM public.promo_redemptions r WHERE r.promo = l.promo),
    GREATEST(0, l.max_redemptions - (SELECT count(*)::INTEGER FROM public.promo_redemptions r WHERE r.promo = l.promo)),
    l.max_redemptions
  FROM public.promo_limits l
  WHERE l.promo = p_promo;
$$;

REVOKE ALL ON FUNCTION public.promo_redemptions_enforce_cap() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_promo_spot(TEXT, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.promo_spot_status(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_promo_spot(TEXT, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.promo_spot_status(TEXT) TO service_role;

-- Carry over any legacy 3-month claims that lived on the PROMO-3MO-SIGNUPS settings row.
INSERT INTO public.promo_redemptions (promo, user_id)
SELECT '3mo', u.id
FROM public.estimates e
CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(e.profile->'userIds', '[]'::jsonb)) AS ids(uid)
JOIN auth.users u ON u.id::text = ids.uid
WHERE e.id = 'PROMO-3MO-SIGNUPS'
ON CONFLICT DO NOTHING;
