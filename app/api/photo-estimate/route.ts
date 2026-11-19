/**
 * POST /api/photo-estimate — 1-5 job photos (+ optional note / measurements) → an
 * itemized estimate (materials + labor per line) plus optional upsell lines.
 * Grok vision proposes the scope; lib/photo-estimate.ts does all the money math.
 * Paywall + daily AI quota (one unit per photo) + per-minute limit.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/supabase/auth-user';
import { enforceAppAccess, workspaceOwnerId } from '@/lib/billing-access';
import { rateLimit, reserveAiQuota, tooManyRequests } from '@/lib/rate-limit';
import { getXaiApiKey, getXaiVisionModel } from '@/lib/xai-config';
import { resolveRegionalPricing, type QuoteLocationInput } from '@/lib/ai-quote-region';
import { formatPriceMemoryForPrompt } from '@/lib/ai-price-memory';
import {
  buildPhotoEstimate,
  buildPhotoEstimatePrompt,
  parseAiJson,
  PHOTO_ESTIMATE_LIMITS,
  sanitizeMeasurements,
  tradeDefaults,
  validatePhotos,
} from '@/lib/photo-estimate';

export const maxDuration = 90;
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const { user, error: authError } = await getUserFromRequest(request);
    if (!user) return NextResponse.json({ error: authError || 'Unauthorized' }, { status: 401 });
    const paywall = await enforceAppAccess(user.id);
    if (paywall) return paywall;

    const minute = await rateLimit(`photo-estimate:${user.id}`, 60, 4);
    if (!minute.allowed) return tooManyRequests(minute, 'Too many photo estimates in a minute. Try again shortly.');

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
    }
    const checked = validatePhotos((body as { photos?: unknown }).photos);
    if ('error' in checked) return NextResponse.json({ error: checked.error }, { status: checked.status });
    const photos = checked.photos;

    const apiKey = getXaiApiKey();
    if (!apiKey) {
      return NextResponse.json({ error: 'AI is not configured on the server.' }, { status: 503 });
    }

    // One daily AI unit per photo (crew share the owner's quota).
    const quota = await reserveAiQuota(await workspaceOwnerId(user.id), 'ai', photos.length);
    if (quota) return quota;

    const b = body as Record<string, unknown>;
    const note = String(b.note || '').trim().slice(0, PHOTO_ESTIMATE_LIMITS.maxNoteChars);
    const tradeId = String(b.tradeId || '').trim().slice(0, 40);
    const measurements = sanitizeMeasurements(b.measurements);
    const regional = resolveRegionalPricing(
      b.jobLocation as QuoteLocationInput | undefined,
      b.companyLocation as QuoteLocationInput | undefined
    );
    const markup = b.markupPercent === '' || b.markupPercent == null ? null : Number(b.markupPercent);

    const prompt = buildPhotoEstimatePrompt({
      note,
      tradeLabel: tradeDefaults(tradeId).label.toLowerCase(),
      regionLabel: regional.label,
      measurements,
      priceMemoryPrompt: formatPriceMemoryForPrompt(b.priceMemory as never),
      photoCount: photos.length,
    });

    const res = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(75_000),
      body: JSON.stringify({
        model: getXaiVisionModel(),
        temperature: 0.2,
        max_tokens: 2500,
        messages: [
          {
            role: 'user',
            content: [
              ...photos.map((url) => ({ type: 'image_url', image_url: { url, detail: 'high' } })),
              { type: 'text', text: prompt },
            ],
          },
        ],
      }),
    });
    if (!res.ok) {
      console.error('photo-estimate vision error:', res.status, (await res.text()).slice(0, 300));
      return NextResponse.json({ error: 'Could not analyze the photos. Try again.' }, { status: 502 });
    }
    const data = await res.json();
    const ai = parseAiJson(String(data?.choices?.[0]?.message?.content || ''));
    if (!ai) {
      return NextResponse.json(
        { error: 'Could not read the photos clearly. Add a short note about the job and try again.' },
        { status: 422 }
      );
    }

    const estimate = buildPhotoEstimate(ai, {
      tradeId,
      markupPercent: markup,
      regional,
      priceMemory: b.priceMemory,
    });
    if (estimate.lines.length === 0) {
      return NextResponse.json(
        { error: 'No priceable work found in the photos. Add a short note about the job and try again.' },
        { status: 422 }
      );
    }
    return NextResponse.json({
      ok: true,
      ...estimate,
      measurements,
      pricingRegion: {
        label: regional.label,
        materialMultiplier: regional.materialMultiplier,
        laborMultiplier: regional.laborMultiplier,
      },
      usage: data?.usage
        ? { promptTokens: data.usage.prompt_tokens, completionTokens: data.usage.completion_tokens }
        : undefined,
    });
  } catch (e) {
    const timeout = e instanceof Error && e.name === 'TimeoutError';
    console.error('photo-estimate:', e instanceof Error ? e.message : e);
    return NextResponse.json(
      { error: timeout ? 'The AI took too long. Try fewer photos.' : 'Could not build the estimate. Please try again.' },
      { status: timeout ? 504 : 500 }
    );
  }
}
