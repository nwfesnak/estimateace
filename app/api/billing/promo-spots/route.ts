import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { CARD_FREE_OFFER_LIMITS, cardFreeOffer } from '@/lib/billing';
import { getPromoSpotStatus } from '@/lib/promo-spots';

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

/**
 * GET /api/billing/promo-spots?promo=6mo → { promo, limit, claimed, remaining, open }
 * Public counter for the capped card-free offers. Read-only; the claim itself
 * happens server-side in start-trial / billing status.
 */
export async function GET(request: NextRequest) {
  const headers = corsHeaders(request.headers.get('origin'));
  const promo = cardFreeOffer(request.nextUrl.searchParams.get('promo') || '6mo');
  if (!promo) {
    return NextResponse.json({ error: 'Not a capped offer.' }, { status: 400, headers });
  }
  const admin = getSupabaseAdmin();
  if (!admin) {
    const limit = CARD_FREE_OFFER_LIMITS[promo];
    return NextResponse.json(
      { promo, limit, claimed: 0, remaining: limit, open: true },
      { headers }
    );
  }
  try {
    const status = await getPromoSpotStatus(admin, promo);
    return NextResponse.json(status, { headers });
  } catch (e) {
    console.error('promo-spots:', e);
    return NextResponse.json({ error: 'Could not read offer spots.' }, { status: 500, headers });
  }
}
