import { getSupabaseClient } from '@/lib/supabase/client';

/**
 * Authorization header used by /api/* routes that call getUserFromRequest.
 * Cookie-only fetches (credentials: 'include') are not enough — those routes
 * require `Authorization: Bearer <supabase access_token>`.
 */
export function authorizationHeaders(
  token: string | null | undefined,
  extra?: HeadersInit
): Headers {
  const headers = new Headers(extra);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return headers;
}

/** The current user's Supabase session JWT, or null if signed out / unconfigured. */
export async function getSessionAccessToken(): Promise<string | null> {
  const supabase = getSupabaseClient();
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token || null;
}

/** fetch() with the session Bearer token, matching other in-app API calls. */
export async function fetchWithSession(
  input: RequestInfo | URL,
  init: RequestInit = {}
): Promise<Response> {
  const headers = authorizationHeaders(await getSessionAccessToken(), init.headers);
  return fetch(input, {
    ...init,
    credentials: init.credentials ?? 'include',
    headers,
  });
}
