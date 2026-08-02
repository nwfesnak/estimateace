import { createClient } from '@supabase/supabase-js';
import type { NextRequest } from 'next/server';

export async function getUserFromRequest(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return { user: null as null, error: 'Missing Authorization bearer token' };
  }
  const token = authHeader.slice(7);
  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').trim();
  const anon = (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '').trim();
  if (!url || !anon) {
    return { user: null as null, error: 'Supabase not configured' };
  }
  const supabase = createClient(url, anon, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  if (error || !user) {
    return { user: null as null, error: 'Unauthorized' };
  }
  return { user, error: null as null };
}
