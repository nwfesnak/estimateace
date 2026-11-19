import { timingSafeEqual } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { purgeDueAccounts } from '@/lib/account-purge';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

function authorized(request: NextRequest, secret: string): boolean {
  const got = Buffer.from(String(request.headers.get('authorization') || ''));
  const want = Buffer.from(`Bearer ${secret}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

/**
 * Daily job: permanently delete accounts whose scheduled close date
 * (subscriptions.account_closes_at, server-only) has passed — even if the user never
 * logs in again. Vercel Cron sends Authorization: Bearer $CRON_SECRET.
 */
export async function GET(request: NextRequest) {
  const cronSecret = (process.env.CRON_SECRET || '').trim();
  if (!cronSecret) {
    return NextResponse.json(
      { error: 'CRON_SECRET is not configured. Refusing to run account purge.' },
      { status: 503 }
    );
  }
  if (!authorized(request, cronSecret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const result = await purgeDueAccounts(25);
  if (result.error) {
    console.error('cron/account-purge:', result.error);
    return NextResponse.json({ ok: false, error: 'Purge query failed' }, { status: 500 });
  }
  return NextResponse.json({ ok: true, ...result });
}
