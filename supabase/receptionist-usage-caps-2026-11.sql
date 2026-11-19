-- ============================================================================
-- AI Receptionist usage counters (cost caps). NOT applied automatically.
-- Apply BEFORE (or right with) deploying the receptionist-cost-caps code: until this
-- exists the AI answers no calls (fail closed) — calls forward / get a call-back message.
--
--   receptionist_usage        per owner, per billing period ('month') and per day ('day'):
--                             AI seconds, forwarded seconds, AI calls, lead SMS, alert flags
--   receptionist_call_usage   one row per CallSid so Twilio retries never double count
--   receptionist_usage_record_call(...)   idempotent add of one finished call
--   receptionist_usage_take_sms(...)      atomically reserve one lead SMS under a cap
--   receptionist_usage_claim_alert(...)   true exactly once per period per alert level
-- Server-only (service_role). Rows cascade-delete with the auth user.
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS public.receptionist_usage (
  user_id          UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  period_kind      TEXT        NOT NULL CHECK (period_kind IN ('month', 'day')),
  period_start     DATE        NOT NULL,
  ai_seconds       INTEGER     NOT NULL DEFAULT 0,
  forward_seconds  INTEGER     NOT NULL DEFAULT 0,
  ai_calls         INTEGER     NOT NULL DEFAULT 0,
  sms_count        INTEGER     NOT NULL DEFAULT 0,
  alert_80_at      TIMESTAMPTZ,
  alert_100_at     TIMESTAMPTZ,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, period_kind, period_start)
);

CREATE TABLE IF NOT EXISTS public.receptionist_call_usage (
  call_sid     TEXT        PRIMARY KEY,
  user_id      UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind         TEXT        NOT NULL CHECK (kind IN ('ai', 'forward')),
  seconds      INTEGER     NOT NULL DEFAULT 0,
  recorded_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS receptionist_call_usage_user_idx
  ON public.receptionist_call_usage (user_id, recorded_at DESC);

ALTER TABLE public.receptionist_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.receptionist_call_usage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.receptionist_usage FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.receptionist_call_usage FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.receptionist_usage TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.receptionist_call_usage TO service_role;

-- Add one finished call (idempotent per CallSid). Returns the new month/day totals.
CREATE OR REPLACE FUNCTION public.receptionist_usage_record_call(
  p_call_sid     TEXT,
  p_user_id      UUID,
  p_kind         TEXT,
  p_seconds      INTEGER,
  p_period_start DATE,
  p_day          DATE
)
RETURNS TABLE (recorded BOOLEAN, month_ai_seconds INTEGER, day_ai_seconds INTEGER, month_forward_seconds INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inserted INTEGER;
  v_ai  INTEGER := CASE WHEN p_kind = 'ai' THEN greatest(0, p_seconds) ELSE 0 END;
  v_fwd INTEGER := CASE WHEN p_kind = 'forward' THEN greatest(0, p_seconds) ELSE 0 END;
  v_calls INTEGER := CASE WHEN p_kind = 'ai' THEN 1 ELSE 0 END;
BEGIN
  INSERT INTO public.receptionist_call_usage (call_sid, user_id, kind, seconds)
  VALUES (p_call_sid, p_user_id, p_kind, greatest(0, p_seconds))
  ON CONFLICT (call_sid) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  IF v_inserted > 0 THEN
    INSERT INTO public.receptionist_usage AS u (user_id, period_kind, period_start, ai_seconds, forward_seconds, ai_calls)
    VALUES (p_user_id, 'month', p_period_start, v_ai, v_fwd, v_calls),
           (p_user_id, 'day',   p_day,          v_ai, v_fwd, v_calls)
    ON CONFLICT (user_id, period_kind, period_start) DO UPDATE
      SET ai_seconds      = u.ai_seconds + EXCLUDED.ai_seconds,
          forward_seconds = u.forward_seconds + EXCLUDED.forward_seconds,
          ai_calls        = u.ai_calls + EXCLUDED.ai_calls,
          updated_at      = now();
  END IF;

  -- Opportunistic cleanup: keep a little over a year of history.
  IF random() < 0.01 THEN
    DELETE FROM public.receptionist_usage WHERE period_start < current_date - 400;
    DELETE FROM public.receptionist_call_usage WHERE recorded_at < now() - interval '400 days';
  END IF;

  RETURN QUERY
  SELECT v_inserted > 0,
         coalesce((SELECT ai_seconds FROM public.receptionist_usage
                   WHERE user_id = p_user_id AND period_kind = 'month' AND period_start = p_period_start), 0),
         coalesce((SELECT ai_seconds FROM public.receptionist_usage
                   WHERE user_id = p_user_id AND period_kind = 'day' AND period_start = p_day), 0),
         coalesce((SELECT forward_seconds FROM public.receptionist_usage
                   WHERE user_id = p_user_id AND period_kind = 'month' AND period_start = p_period_start), 0);
END;
$$;

-- Reserve one lead SMS for this billing period if under p_max.
CREATE OR REPLACE FUNCTION public.receptionist_usage_take_sms(
  p_user_id UUID,
  p_period_start DATE,
  p_max INTEGER
)
RETURNS TABLE (allowed BOOLEAN, used INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_used INTEGER;
BEGIN
  INSERT INTO public.receptionist_usage (user_id, period_kind, period_start)
  VALUES (p_user_id, 'month', p_period_start)
  ON CONFLICT (user_id, period_kind, period_start) DO NOTHING;

  UPDATE public.receptionist_usage
     SET sms_count = sms_count + 1, updated_at = now()
   WHERE user_id = p_user_id AND period_kind = 'month' AND period_start = p_period_start
     AND sms_count < p_max
  RETURNING sms_count INTO v_used;

  IF v_used IS NULL THEN
    SELECT sms_count INTO v_used FROM public.receptionist_usage
     WHERE user_id = p_user_id AND period_kind = 'month' AND period_start = p_period_start;
    RETURN QUERY SELECT false, coalesce(v_used, 0);
  ELSE
    RETURN QUERY SELECT true, v_used;
  END IF;
END;
$$;

-- True exactly once per billing period per level (80 or 100).
CREATE OR REPLACE FUNCTION public.receptionist_usage_claim_alert(
  p_user_id UUID,
  p_period_start DATE,
  p_level INTEGER
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  IF p_level = 80 THEN
    UPDATE public.receptionist_usage SET alert_80_at = now()
     WHERE user_id = p_user_id AND period_kind = 'month' AND period_start = p_period_start
       AND alert_80_at IS NULL;
  ELSIF p_level = 100 THEN
    UPDATE public.receptionist_usage SET alert_100_at = now()
     WHERE user_id = p_user_id AND period_kind = 'month' AND period_start = p_period_start
       AND alert_100_at IS NULL;
  ELSE
    RETURN false;
  END IF;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.receptionist_usage_record_call(TEXT, UUID, TEXT, INTEGER, DATE, DATE) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.receptionist_usage_take_sms(UUID, DATE, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.receptionist_usage_claim_alert(UUID, DATE, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.receptionist_usage_record_call(TEXT, UUID, TEXT, INTEGER, DATE, DATE) TO service_role;
GRANT EXECUTE ON FUNCTION public.receptionist_usage_take_sms(UUID, DATE, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.receptionist_usage_claim_alert(UUID, DATE, INTEGER) TO service_role;

COMMIT;
