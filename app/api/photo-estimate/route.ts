import { requireWorkspaceOwner } from '@/lib/workspace';
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
import { getXaiApiKey, getXaiVisionModel, reasoningEffortFor } from '@/lib/xai-config';
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

/** grok-4.6 vision on up to 5 photos can take 30–90s; leave headroom over the AI timeout. */
export const maxDuration = 180;
/** Abort the xAI call before the function itself is killed so the user gets a real message. */
const AI_TIMEOUT_MS = 150_000;
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const { user, error: authError } = await getUserFromRequest(request);
    if (!user) return NextResponse.json({ error: authError || 'Unauthorized' }, { status: 401 });
    const paywall = await enforceAppAccess(user.id);
    if (paywall) return paywall;
    const ws = await requireWorkspaceOwner(user.id, undefined, { requireTab: ['estimates', 'invoices', 'newEstimate'] });
    if (ws.denied) return ws.denied;

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

    const model = getXaiVisionModel();
    const started = Date.now();
    const res = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(AI_TIMEOUT_MS),
      body: JSON.stringify({
        model,
        // grok-4.x defaults to "high" reasoning (60–110s for multi-image vision, which hit
        // our old 75s abort). "low" is the documented setting for latency-sensitive vision.
        ...(reasoningEffortFor(model) ? { reasoning_effort: reasoningEffortFor(model) } : {}),
        response_format: { type: 'json_object' },
        temperature: 0.2,
        // Reasoning tokens count against this; too low leaves no room for the JSON answer.
        max_tokens: 8000,
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
      console.error('photo-estimate vision error:', res.status, model, (await res.text()).slice(0, 300));
      return NextResponse.json({ error: 'Could not analyze the photos. Try again.' }, { status: 502 });
    }
    const data = await res.json();
    const choice = data?.choices?.[0];
    const ai = parseAiJson(String(choice?.message?.content || ''));
    console.info(
      'photo-estimate:',
      JSON.stringify({
        model,
        photos: photos.length,
        ms: Date.now() - started,
        finish: choice?.finish_reason,
        promptTokens: data?.usage?.prompt_tokens,
        completionTokens: data?.usage?.completion_tokens,
        reasoningTokens: data?.usage?.completion_tokens_details?.reasoning_tokens,
        parsed: Boolean(ai),
      })
    );
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
      {
        error: timeout
          ? 'The AI took too long. Try again with fewer photos.'
          : 'Could not build the estimate. Please try again.',
      },
      { status: timeout ? 504 : 500 }
    );
  }
}
