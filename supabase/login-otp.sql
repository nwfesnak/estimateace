-- ============================================================================
-- Login SMS 2FA codes (run in Supabase SQL Editor)
-- Used by /api/auth/2fa/* with service role.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.login_otp (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.login_otp ENABLE ROW LEVEL SECURITY;

-- No client policies: only service role (bypasses RLS) reads/writes this table.

COMMENT ON TABLE public.login_otp IS 'Short-lived hashed SMS login codes for 2-step verification';
