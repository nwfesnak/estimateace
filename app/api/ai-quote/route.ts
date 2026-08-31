/**
 * Template-first AI quote API.
 * AI classifies + extracts facts only. Fixed templates set price.
 * materials + labor === line total always (reconciled).
 */
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import {
  resolveRegionalPricing,
  type QuoteLineContext,
  type QuoteLocationInput,
} from '@/lib/ai-quote-region';
import { analyzeJobImage } from '@/lib/analyze-job-image';
import { getXaiApiKey } from '@/lib/xai-config';
import {
  normalizeAiPriceMemory,
  type AiPriceMemory,
} from '@/lib/ai-price-memory';
import { extractQuoteScope } from '@/lib/quote-extractor';
import {
  factQuestionsFor,
  priceTemplate,
  type QuoteFacts,
} from '@/lib/quote-templates';

export const maxDuration = 60;
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const rateLimitMap = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT = 10;
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
  if (error || !user) {
    return { user: null, error: 'Unauthorized' };
  }

  return { user, error: null };
}

function checkRateLimit(userId: string): { allowed: boolean; retryAfter?: number } {
  const now = Date.now();
  const entry = rateLimitMap.get(userId);

  if (!entry || now > entry.resetTime) {
    rateLimitMap.set(userId, { count: 1, resetTime: now + WINDOW_MS });
    return { allowed: true };
  }

  if (entry.count >= RATE_LIMIT) {
    return { allowed: false, retryAfter: Math.ceil((entry.resetTime - now) / 1000) };
  }

  entry.count += 1;
  return { allowed: true };
}

function parseFactsBody(raw: any): QuoteFacts {
  if (!raw || typeof raw !== 'object') return {};
  const out: QuoteFacts = {};
  for (const key of [
    'floorSqft',
    'wallSqft',
    'roofSqft',
    'areaSqft',
    'linearFeet',
    'coats',
    'ceilingFt',
    'quantity',
  ] as const) {
    const n = Number(raw[key]);
    if (Number.isFinite(n) && n > 0) out[key] = n;
  }
  if (raw.notes) out.notes = String(raw.notes);
  return out;
}

export async function POST(request: NextRequest) {
  try {
    const { user, error: authError } = await verifyUser(request);
    if (!user) {
      return NextResponse.json({ error: authError || 'Unauthorized' }, { status: 401 });
    }

    const rateCheck = checkRateLimit(user.id);
    if (!rateCheck.allowed) {
      return NextResponse.json(
        { error: `Rate limit exceeded. Try again in ${rateCheck.retryAfter} seconds.` },
        { status: 429, headers: { 'Retry-After': String(rateCheck.retryAfter) } }
      );
    }

    // Extractor may run without Grok (deterministic). Pricing never needs Grok.
    // Photo analysis still needs the key.
    const body = await request.json().catch(() => ({}));
    let jobDescription = String(body?.description || '').trim();
    const imageBase64 = typeof body?.imageBase64 === 'string' ? body.imageBase64 : undefined;
    const imageUrl = typeof body?.imageUrl === 'string' ? body.imageUrl : undefined;
    let imageAnalysis: Awaited<ReturnType<typeof analyzeJobImage>> | null = null;

    if (imageBase64 || imageUrl) {
      if (!getXaiApiKey()) {
        return NextResponse.json(
          {
            error:
              'GROK_API_KEY is missing for photo analysis. Add it in Vercel env, or type a text description instead.',
          },
          { status: 500 }
        );
      }
      try {
        imageAnalysis = await analyzeJobImage({
          imageBase64,
          imageUrl,
          hint: jobDescription,
        });
        jobDescription = imageAnalysis.scopeDescription;
      } catch (err: any) {
        return NextResponse.json(
          { error: err?.message || 'Could not analyze the photo' },
          { status: 400 }
        );
      }
    }

    if (jobDescription.length < 3) {
      return NextResponse.json(
        {
          error:
            imageBase64 || imageUrl
              ? 'Could not extract enough scope from the photo. Add a short text note and try again.'
              : 'Description must be at least 3 characters, or upload a job photo.',
        },
        { status: 400 }
      );
    }

    const jobLocation = (body?.jobLocation || body?.location) as QuoteLocationInput | undefined;
    const companyLocation = body?.companyLocation as QuoteLocationInput | undefined;
    const lineContext = body?.lineContext as QuoteLineContext | undefined;
    const priceMemory: AiPriceMemory = normalizeAiPriceMemory(body?.priceMemory);
    const preferredLaborRate = priceMemory.laborRate;
    const regional = resolveRegionalPricing(jobLocation, companyLocation);

    const factsOverride = parseFactsBody(body?.facts);
    // Line qty can seed wall/area when user already set SF on the line
    const lineQty = Number(lineContext?.qty);
    if (Number.isFinite(lineQty) && lineQty >= 20) {
      const unit = String(lineContext?.unit || '').toLowerCase();
      if (/sf|sqft|sq\.?\s*ft|square/.test(unit)) {
        if (!factsOverride.floorSqft && lineQty >= 400) factsOverride.floorSqft = lineQty;
        if (!factsOverride.wallSqft && lineQty < 400) factsOverride.wallSqft = lineQty;
        if (!factsOverride.areaSqft) factsOverride.areaSqft = lineQty;
        if (!factsOverride.roofSqft && lineQty >= 200) factsOverride.roofSqft = lineQty;
      }
      if (/lf|lin|ft|feet/i.test(unit) && !factsOverride.linearFeet) {
        factsOverride.linearFeet = lineQty;
      }
    }

    const templateIdOverride = body?.templateId
      ? String(body.templateId).trim()
      : undefined;

    const extracted = await extractQuoteScope({
      description: jobDescription,
      factsOverride,
      templateIdOverride,
      skipLlm: body?.skipLlm === true,
    });

    if (extracted.missingFacts.length > 0) {
      return NextResponse.json({
        needsFacts: true,
        templateId: extracted.templateId,
        templateLabel: extracted.templateLabel,
        missingFacts: extracted.missingFacts,
        questions: factQuestionsFor(extracted.templateId, extracted.missingFacts),
        partialFacts: extracted.facts,
        scopeSummary: extracted.scopeSummary,
        confidence: extracted.confidence,
        pricingMethod: 'template-v1',
        analyzedScope: imageAnalysis?.scopeDescription || undefined,
        imageAnalysis: imageAnalysis || undefined,
        pricingRegion: {
          label: regional.label,
          state: regional.state,
          materialMultiplier: regional.materialMultiplier,
          laborMultiplier: regional.laborMultiplier,
          costTier: regional.costTier,
        },
        message: `Need a few details to price “${extracted.templateLabel}” accurately.`,
      });
    }

    const quote = priceTemplate(
      extracted.templateId,
      extracted.facts,
      regional,
      jobDescription,
      preferredLaborRate
    );

    // Identity check — should already hold from reconcileQuote
    const built = Math.round((quote.materialsCostTotal + quote.laborCostTotal) * 100) / 100;
    if (Math.abs(built - quote.total) > 0.05) {
      console.error('template quote identity fail', {
        built,
        total: quote.total,
        templateId: quote.templateId,
      });
    }

    return NextResponse.json({
      unitPrice: quote.unitPrice,
      unit: quote.unit,
      suggestedQty: quote.suggestedQty,
      total: quote.total,
      billingMode: quote.billingMode,
      breakdown: quote.breakdown,
      confidence: quote.confidence,
      materials: quote.materials,
      laborBreakdown: quote.laborBreakdown,
      materialsCostTotal: quote.materialsCostTotal,
      laborCostTotal: quote.laborCostTotal,
      pricingMethod: 'template-v1',
      templateId: quote.templateId,
      templateLabel: extracted.templateLabel,
      factsUsed: quote.factsUsed,
      scopeSummary: extracted.scopeSummary,
      extractSource: extracted.source,
      analyzedScope: imageAnalysis?.scopeDescription || undefined,
      imageAnalysis: imageAnalysis || undefined,
      pricingRegion: {
        label: regional.label,
        state: regional.state,
        materialMultiplier: regional.materialMultiplier,
        laborMultiplier: regional.laborMultiplier,
        costTier: regional.costTier,
      },
      // No competing built-up — total is the only bid
      priceRange: null,
    });
  } catch (e: any) {
    console.error('ai-quote template error:', e);
    return NextResponse.json(
      { error: e?.message || 'Could not price this description' },
      { status: 500 }
    );
  }
}
