import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/supabase/auth-user';
import { analyzeReceiptImage } from '@/lib/analyze-receipt-image';

/**
 * AI receipt scan — Grok vision extracts total / vendor / date from a receipt image.
 * Body: { imageUrl?: string, imageBase64?: string }
 */
export async function POST(request: NextRequest) {
  try {
    const { user, error: authError } = await getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: authError || 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));
    const imageUrl = String(body.imageUrl || '').trim();
    const imageBase64 = String(body.imageBase64 || '').trim();

    if (!imageUrl && !imageBase64) {
      return NextResponse.json({ error: 'imageUrl or imageBase64 is required' }, { status: 400 });
    }

    const result = await analyzeReceiptImage({
      imageUrl: imageUrl || undefined,
      imageBase64: imageBase64 || undefined,
    });

    return NextResponse.json({ ok: true, ...result });
  } catch (e: any) {
    console.error('receipts/scan:', e);
    const msg = e?.message || 'Receipt scan failed';
    const status = /GROK_API_KEY|missing/i.test(msg) ? 500 : 400;
    return NextResponse.json({ error: msg }, { status });
  }
}
