-- Store-reviewer demo login: service-role-only password check for the
-- allowlisted App Review / Play Console account. Lets POST /api/auth/reviewer-login
-- verify the real Auth password without Cloudflare Turnstile.
-- Privileges: execute revoked from PUBLIC, anon, and authenticated.

CREATE OR REPLACE FUNCTION public.reviewer_demo_password_ok(p_email text, p_password text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = auth, public, extensions
AS $$
BEGIN
  IF lower(trim(coalesce(p_email, ''))) IS DISTINCT FROM 'appreview@estimateace.com' THEN
    RETURN false;
  END IF;
  IF p_password IS NULL OR length(p_password) = 0 THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1
    FROM auth.users u
    WHERE lower(u.email) = 'appreview@estimateace.com'
      AND u.deleted_at IS NULL
      AND u.encrypted_password = extensions.crypt(p_password, u.encrypted_password)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.reviewer_demo_password_ok(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reviewer_demo_password_ok(text, text) FROM anon;
REVOKE ALL ON FUNCTION public.reviewer_demo_password_ok(text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.reviewer_demo_password_ok(text, text) TO service_role;
