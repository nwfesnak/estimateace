-- ============================================================================
-- EstimateAce — inactive 60-day trial cleanup (2026-11)
--
-- Daily cron /api/cron/trial-inactivity:
--   day 20 without signing in  → warning email (sign in within 10 days)
--   day 30 (≥10 days after the warning, still no sign-in) → export email with all
--   their data, then the existing full account deletion.
-- Signing in (or the app refreshing its session) at any time resets the clock.
--
-- This file creates:
--   * trial_inactivity_log  — one row per warning cycle (warning / export / deleted
--     times). Rows are kept after the account is deleted as the audit trail; they hold
--     no personal data (user id + timestamps + email ids from Resend).
--   * account-exports       — private storage bucket for the export zip + photo copies
--     (must survive the account deletion; removed by the cron after ~31 days).
--   * trial_inactivity_candidates() — service-role-only view of trial owners and when
--     they were last active (auth.users + auth.sessions are not reachable via the API).
--
-- NOT applied automatically. Run in the Supabase SQL editor (production) before setting
-- TRIAL_INACTIVITY_MODE=live. Safe to re-run.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.trial_inactivity_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- No FK: the row must outlive the deleted auth user.
  user_id UUID NOT NULL,
  -- Last activity we saw when the warning went out (the cycle's anchor).
  last_active_at TIMESTAMPTZ,
  warning_sent_at TIMESTAMPTZ,
  warning_email_id TEXT,
  -- Set when the user came back (signed in) after the warning; the cycle is over.
  cleared_at TIMESTAMPTZ,
  export_sent_at TIMESTAMPTZ,
  export_email_id TEXT,
  export_prefix TEXT,
  export_expires_at TIMESTAMPTZ,
  export_files_purged_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- At most one open cycle per user (makes the warning idempotent under retries).
CREATE UNIQUE INDEX IF NOT EXISTS trial_inactivity_log_one_open
  ON public.trial_inactivity_log (user_id)
  WHERE cleared_at IS NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS trial_inactivity_log_export_purge
  ON public.trial_inactivity_log (export_expires_at)
  WHERE export_prefix IS NOT NULL AND export_files_purged_at IS NULL;

ALTER TABLE public.trial_inactivity_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.trial_inactivity_log FROM anon, authenticated;

-- Private bucket for exports (never public; links are signed URLs that expire).
INSERT INTO storage.buckets (id, name, public)
VALUES ('account-exports', 'account-exports', false)
ON CONFLICT (id) DO UPDATE SET public = false;

-- Trial owners + last activity. Excludes: paying / comped accounts (status <> trialing),
-- accounts already scheduled to close (handled by the account-purge cron), anyone who is
-- crew on another account, owners paying for crew seats or the AI Receptionist add-on.
CREATE OR REPLACE FUNCTION public.trial_inactivity_candidates(
  p_offers TEXT[] DEFAULT ARRAY['2mo'],
  p_min_inactive_days INTEGER DEFAULT 20
)
RETURNS TABLE (
  user_id UUID,
  email TEXT,
  full_name TEXT,
  signup_offer TEXT,
  status TEXT,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  trial_started_at TIMESTAMPTZ,
  trial_ends_at TIMESTAMPTZ,
  last_active_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  WITH activity AS (
    SELECT u.id,
           GREATEST(
             u.created_at,
             COALESCE(u.last_sign_in_at, u.created_at),
             COALESCE((SELECT max(GREATEST(s.updated_at,
                                           COALESCE(s.refreshed_at AT TIME ZONE 'UTC', s.updated_at)))
                       FROM auth.sessions s WHERE s.user_id = u.id), u.created_at)
           ) AS last_active_at
    FROM auth.users u
  )
  SELECT u.id,
         u.email::TEXT,
         COALESCE(u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name', '')::TEXT,
         CASE
           WHEN lower(COALESCE(u.raw_user_meta_data->>'promo', '')) IN ('2mo', '2months', '60', 'two-months') THEN '2mo'
           WHEN lower(COALESCE(u.raw_user_meta_data->>'promo', '')) IN ('6mo', '6months', '180') THEN '6mo'
           WHEN sub.trial_ends_at IS NOT NULL
                AND sub.trial_ends_at - sub.created_at BETWEEN interval '55 days' AND interval '65 days' THEN '2mo'
           ELSE 'standard'
         END,
         sub.status,
         sub.stripe_customer_id,
         sub.stripe_subscription_id,
         sub.created_at,
         sub.trial_ends_at,
         a.last_active_at
  FROM auth.users u
  JOIN public.subscriptions sub ON sub.user_id = u.id
  JOIN activity a ON a.id = u.id
  WHERE sub.status = 'trialing'
    AND sub.account_closes_at IS NULL
    AND u.deleted_at IS NULL
    AND a.last_active_at <= now() - make_interval(days => GREATEST(p_min_inactive_days, 1))
    AND NOT EXISTS (SELECT 1 FROM public.crew_members cm WHERE cm.crew_user_id = u.id)
    AND NOT EXISTS (
      SELECT 1 FROM public.crew_seat_subscriptions cs
      WHERE cs.owner_user_id = u.id AND cs.stripe_subscription_id IS NOT NULL
        AND COALESCE(cs.status, '') NOT IN ('canceled', 'incomplete_expired')
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.receptionist_accounts ra
      WHERE ra.user_id = u.id
        AND COALESCE(ra.billing->>'stripeSubscriptionId', '') <> ''
        AND lower(COALESCE(ra.billing->>'status', '')) IN ('active', 'trialing', 'past_due')
    )
    AND (
      CASE
        WHEN lower(COALESCE(u.raw_user_meta_data->>'promo', '')) IN ('2mo', '2months', '60', 'two-months') THEN '2mo'
        WHEN lower(COALESCE(u.raw_user_meta_data->>'promo', '')) IN ('6mo', '6months', '180') THEN '6mo'
        WHEN sub.trial_ends_at IS NOT NULL
             AND sub.trial_ends_at - sub.created_at BETWEEN interval '55 days' AND interval '65 days' THEN '2mo'
        ELSE 'standard'
      END
    ) = ANY (p_offers)
  ORDER BY a.last_active_at ASC
  LIMIT 500;
$$;

REVOKE ALL ON FUNCTION public.trial_inactivity_candidates(TEXT[], INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trial_inactivity_candidates(TEXT[], INTEGER) TO service_role;
