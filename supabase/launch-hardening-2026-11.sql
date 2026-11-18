-- EstimateAce launch hardening (Nov 2026)
-- Run once in Supabase SQL Editor (project jiujzujkednnkjymawdk) AFTER the PR deploys.
-- Safe to re-run.
--
-- 1) Crew seats: new crew rows start as 'pending_payment' (login disabled until the
--    $14.99 seat is paid). Existing rows keep their current seat_status.
ALTER TABLE public.crew_members
  ALTER COLUMN seat_status SET DEFAULT 'pending_payment';

-- 2) Tighten the crew lookup used by RLS (estimates, archive-est, subscriptions, media).
--    - requires a signed-in caller (auth.uid() not null)
--    - only grants owner-workspace access while the crew seat is paid / inside a paid period
--    - EXECUTE revoked from PUBLIC/anon; only authenticated (needed by RLS policies) + service_role
CREATE OR REPLACE FUNCTION public.is_crew_of(owner_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT auth.uid() IS NOT NULL
    AND owner_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.crew_members cm
      WHERE cm.owner_user_id = owner_id
        AND cm.crew_user_id = auth.uid()
        AND (
          coalesce(cm.seat_status, 'active') IN ('active', 'trialing', 'past_due', 'canceling')
          OR (
            cm.seat_status IN ('canceled', 'unpaid')
            AND cm.seat_period_end IS NOT NULL
            AND cm.seat_period_end > now()
          )
        )
    );
$function$;

REVOKE ALL ON FUNCTION public.is_crew_of(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_crew_of(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.is_crew_of(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_crew_of(uuid) TO service_role;

-- is_full_crew_of exists in supabase/crew-members.sql but not in production; if you add it,
-- apply the same seat check and grants.

-- Note: the Supabase advisor will still list is_crew_of as "SECURITY DEFINER executable by
-- authenticated". That is intentional: RLS policies call it as the signed-in user, and it only
-- answers "am I (auth.uid()) paid crew of owner_id?", so it reveals nothing about other users.
