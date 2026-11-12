import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { THREE_MONTH_PROMO_LIMIT } from '@/lib/billing';
import { getThreeMonthPromoStatus } from '@/lib/promo-3mo';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ALLOWED_ORIGINS = new Set([
  'https://estimateace.com',
  'https://www.estimateace.com',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
]);

function corsHeaders(origin: string | null): HeadersInit {
  const allow = origin && ALLOWED_ORIGINS.has(origin) ? origin : null;
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin',
  };
  if (allow) headers['Access-Control-Allow-Origin'] = allow;
  return headers;
}

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, {
    status: 204,
    headers: corsHeaders(request.headers.get('origin')),
  });
}

/** How many of the 20 three-month spots are left. Used by the public landing page. */
export async function GET(request: NextRequest) {
  const headers = corsHeaders(request.headers.get('origin'));
  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      {
        limit: THREE_MONTH_PROMO_LIMIT,
        claimed: 0,
        remaining: THREE_MONTH_PROMO_LIMIT,
        open: true,
      },
      { headers }
    );
  }
  try {
    const status = await getThreeMonthPromoStatus(admin);
    return NextResponse.json(status, { headers });
  } catch (e) {
    console.error('promo-3mo:', e);
    return NextResponse.json(
      { error: 'Could not read offer spots.' },
      { status: 500, headers }
    );
  }
}
