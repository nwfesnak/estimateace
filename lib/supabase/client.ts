import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const globalForSupabase = globalThis as typeof globalThis & {
  __estimateaceSupabase?: SupabaseClient;
};

export function getSupabaseClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
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