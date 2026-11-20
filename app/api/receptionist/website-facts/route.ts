import { crewPermissionDeniedResponse, requireWorkspaceOwner } from '@/lib/workspace';
import { NextRequest, NextResponse } from 'next/server';
import { TWO_STEP_REQUIRED, twoStepPending } from '@/lib/supabase/auth-user';
import { createClient } from '@supabase/supabase-js';
import { buildWebsiteBusinessFacts } from '@/lib/receptionist-website-facts';
import { reserveAiQuota } from '@/lib/rate-limit';
import { enforceAppAccess, workspaceOwnerId } from '@/lib/billing-access';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const rateLimitMap = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT = 6;
const WINDOW_MS = 60 * 1000;

async function verifyUser(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return { user: null, error: 'Missing or invalid Authorization header' };
  }
  const token = authHeader.split(' ')[1];
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  if (!supabaseUrl || !supabaseAnonKey) {
    return { user: null, error: 'Supabase not configured' };
  }
  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  if (error || !user) return { user: null, error: 'Unauthorized' };
  if (twoStepPending(request, user)) return { user: null, error: TWO_STEP_REQUIRED };
  return { user, error: null };
}

function rateLimited(userId: string): boolean {
  const now = Date.now();
  const row = rateLimitMap.get(userId);
  if (!row || now > row.resetTime) {
    rateLimitMap.set(userId, { count: 1, resetTime: now + WINDOW_MS });
    return false;
  }
  if (row.count >= RATE_LIMIT) return true;
  row.count += 1;
  return false;
}

/** POST /api/receptionist/website-facts — fill business facts from the company website. */
export async function POST(request: NextRequest) {
  try {
    const { user, error: authError } = await verifyUser(request);
    if (!user) {
      return NextResponse.json({ error: authError || 'Unauthorized' }, { status: 401 });
    }
    if (rateLimited(user.id)) {
      return NextResponse.json(
        { error: 'Wait a minute, then fill facts from the website again.' },
        { status: 429 }
      );
    }

    // Paid feature: trial / active subscription (or promo) required before any AI spend.
    const paywall = await enforceAppAccess(user.id);
    if (paywall) return paywall;
    const ws = await requireWorkspaceOwner(user.id, undefined, { requireTab: 'receptionist' });
    if (ws.denied) return ws.denied;
    if (ws.isCrew) return crewPermissionDeniedResponse();

    {
      const quota = await reserveAiQuota(await workspaceOwnerId(user.id), 'ai');
      if (quota) return quota;
    }

    const body = await request.json().catch(() => ({}));
    const websiteUrl = String(body?.websiteUrl || '').trim();
    if (!websiteUrl) {
      return NextResponse.json(
        { error: 'Enter your company website first.' },
        { status: 400 }
      );
    }

    const result = await buildWebsiteBusinessFacts(websiteUrl);
    return NextResponse.json(result);
  } catch (e) {
    const raw = e instanceof Error ? e.message : 'Could not read that website.';
    const message = /aborted|timeout|timed out/i.test(raw)
      ? 'Reading that website took too long. Try again.'
      : raw;
    const status = /public company website/i.test(message) ? 400 : 422;
    return NextResponse.json({ error: message }, { status });
  }
}
