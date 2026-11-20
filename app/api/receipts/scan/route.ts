import { requireWorkspaceOwner } from '@/lib/workspace';
import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/supabase/auth-user';
import { analyzeReceiptImage } from '@/lib/analyze-receipt-image';
import { enforceAppAccess, workspaceOwnerId } from '@/lib/billing-access';
import { rateLimit, reserveAiQuota, tooManyRequests } from '@/lib/rate-limit';

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
    const paywall = await enforceAppAccess(user.id);
    if (paywall) return paywall;
    const ws = await requireWorkspaceOwner(user.id, undefined, { requireTab: ['estimates', 'invoices', 'newEstimate', 'reports'] });
    if (ws.denied) return ws.denied;

    const burst = await rateLimit(`ai:receipt-scan:min:${user.id}`, 60, 10);
    if (!burst.allowed) return tooManyRequests(burst, 'Too many receipt scans. Wait a minute and try again.');

    const body = await request.json().catch(() => ({}));
    const imageUrl = String(body.imageUrl || '').trim();
    const imageBase64 = String(body.imageBase64 || '').trim();
    if (imageUrl.length > 2048 || !/^(https:\/\/|$)/i.test(imageUrl)) {
      return NextResponse.json({ error: 'Invalid image link.' }, { status: 400 });
    }
    // ~10 MB image as base64
    if (imageBase64.length > 14_000_000) {
      return NextResponse.json({ error: 'That image is too large (max 10 MB).' }, { status: 413 });
    }

    if (!imageUrl && !imageBase64) {
      return NextResponse.json({ error: 'imageUrl or imageBase64 is required' }, { status: 400 });
    }
    {
      const quota = await reserveAiQuota(await workspaceOwnerId(user.id), 'ai');
      if (quota) return quota;
    }

    const result = await analyzeReceiptImage({
      imageUrl: imageUrl || undefined,
      imageBase64: imageBase64 || undefined,
    });

    return NextResponse.json({ ok: true, ...result });
  } catch (e: any) {
    console.error('receipts/scan:', e?.message || e);
    const msg = String(e?.message || '');
    const status = /GROK_API_KEY|missing/i.test(msg) ? 500 : 400;
    return NextResponse.json(
      { error: status === 500 ? 'Receipt scan is unavailable right now.' : 'Could not read that receipt. Try a clearer photo.' },
      { status }
    );
  }
}
