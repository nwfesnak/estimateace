import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const globalForSupabase = globalThis as typeof globalThis & {
  __estimateaceSupabase?: SupabaseClient;
};

function readPublicEnv(name: 'NEXT_PUBLIC_SUPABASE_URL' | 'NEXT_PUBLIC_SUPABASE_ANON_KEY') {
  // Next inlines NEXT_PUBLIC_* at build time for the browser bundle.
  // Empty/whitespace values must be treated as missing.
  const value = process.env[name];
  if (typeof value !== 'string') return '';
  return value.trim();
}

/** True when both public Supabase keys are present (build-time / runtime). */
export function isSupabaseConfigured(): boolean {
  return Boolean(readPublicEnv('NEXT_PUBLIC_SUPABASE_URL') && readPublicEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY'));
}

/**
 * Human-readable setup hint. Does not reveal secret values.
 * Live (Vercel) and local use different places to store the same two keys.
 */
export function getSupabaseConfigHelpMessage(): string {
  const hasUrl = Boolean(readPublicEnv('NEXT_PUBLIC_SUPABASE_URL'));
  const hasKey = Boolean(readPublicEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY'));
  const missing = [
    !hasUrl ? 'NEXT_PUBLIC_SUPABASE_URL' : null,
    !hasKey ? 'NEXT_PUBLIC_SUPABASE_ANON_KEY' : null,
  ].filter(Boolean);

  const where =
    typeof window !== 'undefined' && !window.location.hostname.includes('localhost')
      ? 'Vercel → Project → Settings → Environment Variables (Production + Preview), then Redeploy'
      : '.env.local in the project folder, then restart npm run dev';

  if (missing.length === 0) {
    return 'Supabase keys look present but the client failed to start. Try a hard refresh or redeploy.';
  }

  return `Supabase is not configured (missing ${missing.join(' and ')}). Add them in ${where}. Copy URL + anon key from Supabase → Project Settings → API. This is separate from the last app update — keys are not stored in git.`;
}

export function getSupabaseClient(): SupabaseClient | null {
  const url = readPublicEnv('NEXT_PUBLIC_SUPABASE_URL');
  const key = readPublicEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY');
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