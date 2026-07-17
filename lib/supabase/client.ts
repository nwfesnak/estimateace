import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const globalForSupabase = globalThis as typeof globalThis & {
  __estimateaceSupabase?: SupabaseClient;
};

/**
 * IMPORTANT: Next.js only inlines NEXT_PUBLIC_* when accessed with a *static*
 * property name (process.env.NEXT_PUBLIC_FOO). Dynamic access like
 * process.env[name] is always undefined in the browser bundle — which made
 * login show "Supabase is not configured" even when Vercel env vars were set.
 */
function getSupabaseUrl(): string {
  return (process.env.NEXT_PUBLIC_SUPABASE_URL || '').trim();
}

function getSupabaseAnonKey(): string {
  return (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '').trim();
}

/** True when both public Supabase keys are present in the build. */
export function isSupabaseConfigured(): boolean {
  return Boolean(getSupabaseUrl() && getSupabaseAnonKey());
}

/**
 * Human-readable setup hint. Does not reveal secret values.
 */
export function getSupabaseConfigHelpMessage(): string {
  const hasUrl = Boolean(getSupabaseUrl());
  const hasKey = Boolean(getSupabaseAnonKey());
  const missing = [
    !hasUrl ? 'NEXT_PUBLIC_SUPABASE_URL' : null,
    !hasKey ? 'NEXT_PUBLIC_SUPABASE_ANON_KEY' : null,
  ].filter(Boolean);

  const onLocalhost =
    typeof window !== 'undefined' &&
    (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');

  const where = onLocalhost
    ? '.env.local in the project folder, then restart npm run dev'
    : 'Vercel → Project → Settings → Environment Variables (Production + Preview), then Redeploy';

  if (missing.length === 0) {
    return 'Supabase keys look present but the client failed to start. Try a hard refresh or redeploy.';
  }

  return `Supabase is not configured (missing ${missing.join(' and ')}). Add them in ${where}. Copy URL + anon key from Supabase → Project Settings → API.`;
}

export function getSupabaseClient(): SupabaseClient | null {
  const url = getSupabaseUrl();
  const key = getSupabaseAnonKey();
  if (!url || !key) return null;

  if (!globalForSupabase.__estimateaceSupabase) {
    globalForSupabase.__estimateaceSupabase = createClient(url, key, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        storageKey: 'estimateace-auth',
      },
    });
  }

  return globalForSupabase.__estimateaceSupabase;
}
