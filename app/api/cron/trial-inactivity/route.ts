import { timingSafeEqual } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { getStripe } from '@/lib/stripe-server';
import { runTrialInactivity } from '@/lib/trial-inactivity-runner';
import { buildTrialInactivityDeps } from '@/lib/trial-inactivity-deps';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

function authorized(request: NextRequest, secret: string): boolean {
  const got = Buffer.from(String(request.headers.get('authorization') || ''));
  const want = Buffer.from(`Bearer ${secret}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

/**
 * Daily: inactive 60-day launch-promotion trials.
 *   20 days without signing in → warning email; 30 days (≥10 days after the warning)
 *   → export email with all their data, then full account deletion.
 * Vercel Cron sends Authorization: Bearer $CRON_SECRET.
 *
 * Runs as a DRY RUN (nothing written, nothing sent) unless TRIAL_INACTIVITY_MODE=live.
 * `?dryRun=1` forces a dry run even when live.
 */
export async function GET(request: NextRequest) {
  const cronSecret = (process.env.CRON_SECRET || '').trim();
  if (!cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET is not configured.' }, { status: 503 });
  }
  if (!authorized(request, cronSecret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const admin = getSupabaseAdmin();
  if (!admin) return NextResponse.json({ error: 'No admin client' }, { status: 500 });

  const mode = String(process.env.TRIAL_INACTIVITY_MODE || '').trim().toLowerCase();
  const forceDry = ['1', 'true', 'yes'].includes(String(request.nextUrl.searchParams.get('dryRun') || '').toLowerCase());
  const dryRun = forceDry || mode !== 'live';

  try {
    const report = await runTrialInactivity(buildTrialInactivityDeps(admin, getStripe()), { dryRun });
    if (report.errors.length) console.error('cron/trial-inactivity errors:', report.errors);
    console.info(
      'cron/trial-inactivity:',
      JSON.stringify({ dryRun, counts: report.counts, done: report.done, candidates: report.candidates })
    );
    return NextResponse.json({ ok: report.errors.length === 0, mode: dryRun ? 'dry-run' : 'live', ...report });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('cron/trial-inactivity:', msg);
    const missing = /trial_inactivity|does not exist|schema cache/i.test(msg);
    return NextResponse.json(
      { ok: false, error: missing ? 'Run supabase/trial-inactivity-2026-11.sql first.' : 'Run failed' },
      { status: missing ? 503 : 500 }
    );
  }
}
