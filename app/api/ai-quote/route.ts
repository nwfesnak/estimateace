// app/api/ai-quote/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import {
  buildQuoteUserMessage,
  buildRegionalPromptSection,
  resolveRegionalPricing,
  type QuoteLineContext,
  type QuoteLocationInput,
} from '@/lib/ai-quote-region';
import { computePricingAnchor, detectWholeHomeInteriorPaint, estimateInteriorPaintableSqft } from '@/lib/ai-quote-anchor';
import { resolveQuoteLineStructure } from '@/lib/quote-units';
import { analyzeJobImage, type JobImageAnalysis } from '@/lib/analyze-job-image';
import { getXaiApiKey, getXaiChatModel } from '@/lib/xai-config';
import {
  calibrateMaterialPrices,
  recalcMaterialLine,
  sumMaterialTotals,
  type MarketMaterialLine,
} from '@/lib/market-material-caps';
import { formatLowesPriceGuideForPrompt } from '@/lib/lowes-material-prices';
import { alignBreakdownToUnitPrice } from '@/lib/breakdown-pricing';
import {
  applyPriceMemoryToBreakdown,
  formatPriceMemoryForPrompt,
  normalizeAiPriceMemory,
  type AiPriceMemory,
} from '@/lib/ai-price-memory';
import {
  blendWithTaskMarket,
  estimateUnitJobLaborHours,
} from '@/lib/task-market-pricing';

// Simple in-memory rate limiter (per-user, resets on server restart)
// For production: use Redis / Upstash / Vercel KV with proper middleware
const rateLimitMap = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT = 10; // requests
const WINDOW_MS = 60 * 1000; // 1 minute

const roundMoney = (n: number) => Math.round(n * 100) / 100;

type MaterialLine = MarketMaterialLine;

const MISC_SUPPLY_PATTERNS =
  /fastener|screw|nail|bolt|anchor|staple|tape|adhesive|glue|caulk|sealant|primer|connector|fitting|coupling|strap|clip|bracket|wire nut|sandpaper|blade|bit|consumable|misc/i;

type LaborBreakdown = {
  description: string;
  hours: number;
  rate: number;
  total: number;
};

type JobScope = {
  scopeQty: number;
  measure: 'sqft' | 'lf' | 'ea' | 'job';
};

type JobLaborGuide = {
  minHours: number;
  maxHours: number;
  expectedHours: number;
  scope: JobScope;
  isMultiUnit: boolean;
};

function parseJobScope(description: string, suggestedQty: number, unit = ''): JobScope {
  const text = description.toLowerCase();
  const unitNorm = unit.toLowerCase().trim();

  const sqftFromText = text.match(
    /(\d[\d,]*)\s*(?:sq\.?\s*ft|sqft|sf|square\s*feet|square\s*foot)\b/i
  );
  if (sqftFromText) {
    return {
      scopeQty: Number(sqftFromText[1].replace(/,/g, '')) || suggestedQty,
      measure: 'sqft',
    };
  }

  const squaresFromText = text.match(/(\d[\d,]*)\s*(?:squares?|sqs?)\b/i);
  if (squaresFromText) {
    return {
      scopeQty: (Number(squaresFromText[1].replace(/,/g, '')) || 0) * 100,
      measure: 'sqft',
    };
  }

  if (/sqft|sq ft|sf|square/.test(unitNorm) && suggestedQty > 1) {
    return { scopeQty: suggestedQty, measure: 'sqft' };
  }
  if (/lf|ln\s*ft|linear/.test(unitNorm) && suggestedQty > 1) {
    return { scopeQty: suggestedQty, measure: 'lf' };
  }
  if (suggestedQty > 1 && /roof|shingle|floor|tile|paint|siding|drywall|laminate/i.test(text)) {
    return { scopeQty: suggestedQty, measure: 'sqft' };
  }

  return { scopeQty: Math.max(1, suggestedQty), measure: 'ea' };
}

/** Total crew-hours for the FULL job scope (not per sqft). */
function estimateJobLaborHours(
  description: string,
  suggestedQty: number,
  unit = ''
): JobLaborGuide {
  const text = description.toLowerCase();
  const scope = parseJobScope(description, suggestedQty, unit);
  const isMultiUnit = suggestedQty > 1 || scope.scopeQty > 1;
  const { maxHoursPerUnit } = detectLaborRateCap(description);

  const finish = (
    minHours: number,
    expectedHours: number,
    maxHours: number
  ): JobLaborGuide => ({
    minHours: roundMoney(Math.max(0.5, minHours)),
    expectedHours: roundMoney(Math.max(0.5, expectedHours)),
    maxHours: roundMoney(Math.max(minHours, maxHours)),
    scope,
    isMultiUnit,
  });

  if (scope.measure === 'sqft') {
    const sqft = scope.scopeQty;
    const squares = sqft / 100;

    const wholeHomePaint = detectWholeHomeInteriorPaint(description);
    if (wholeHomePaint) {
      const paintableSqft = estimateInteriorPaintableSqft(
        wholeHomePaint.floorSqft,
        wholeHomePaint.ceilingFt
      );
      const coats = wholeHomePaint.coats;
      const production = coats === 1 ? 145 : coats === 2 ? 95 : 70;
      return finish(
        paintableSqft / (production * 1.2),
        paintableSqft / production,
        paintableSqft / (production * 0.82)
      );
    }

    if (/roof|shingle|re-?roof|tear[\s-]?off/i.test(text)) {
      // ~1.5–3.5 crew-hours per square (100 sqft); full replacement includes tear-off.
      return finish(squares * 1.5, squares * 2.5, squares * 4.5);
    }
    if (/paint|primer|coat/i.test(text)) {
      return finish(sqft / 250, sqft / 175, sqft / 120);
    }
    if (/floor|tile|laminate|hardwood|lvp|vinyl|carpet/i.test(text)) {
      return finish(sqft / 45, sqft / 30, sqft / 18);
    }
    if (/drywall|sheetrock|hang|mud|tape/i.test(text)) {
      return finish(sqft / 55, sqft / 38, sqft / 25);
    }
    if (/siding|stucco|exterior/i.test(text)) {
      return finish(sqft / 40, sqft / 28, sqft / 18);
    }
    return finish(sqft / 50, sqft / 35, sqft / 22);
  }

  if (scope.measure === 'lf') {
    const lf = scope.scopeQty;
    if (/fence/i.test(text)) return finish(lf / 12, lf / 8, lf / 5);
    if (/gutter/i.test(text)) return finish(lf / 20, lf / 14, lf / 9);
    if (/pipe|wire|conduit/i.test(text)) return finish(lf / 25, lf / 16, lf / 10);
    return finish(lf / 15, lf / 10, lf / 6);
  }

  // Unit / each jobs — use task-specific hours (NOT trade-day maxHoursPerUnit).
  // Old bug: toilet/faucet used 5–20 hrs because maxHoursPerUnit was treated as expected.
  const qty = Math.max(1, scope.scopeQty);
  const unitGuide = estimateUnitJobLaborHours(description);
  if (unitGuide) {
    const minH = unitGuide.minHours * Math.min(qty, 4);
    const expH = unitGuide.expectedHours * Math.min(qty, 4);
    const maxH = unitGuide.maxHours * Math.min(qty, 6);
    // For 5+ identical units, add diminishing hours beyond the first few
    if (qty > 4) {
      const extra = (qty - 4) * unitGuide.expectedHours * 0.75;
      return finish(minH + extra * 0.6, expH + extra, maxH + extra * 1.1);
    }
    return finish(minH, expH, maxH);
  }

  // Fallback: modest handyman-scale hours (never multi-day trade max as "expected")
  if (qty <= 4) {
    return finish(1, Math.min(4, maxHoursPerUnit * 0.35), Math.min(10, maxHoursPerUnit * 0.75));
  }
  return finish(
    Math.min(8, maxHoursPerUnit * 0.5),
    Math.min(16, maxHoursPerUnit),
    Math.min(40, maxHoursPerUnit * 2.5)
  );
}

function detectLaborRateCap(
  description: string,
  laborMultiplier = 1
): { maxRate: number; typicalRate: number; maxHoursPerUnit: number } {
  const scale = (n: number) => roundMoney(n * laborMultiplier);
  const text = description.toLowerCase();
  if (/electrical|electrician|panel|wiring|outlet|circuit/i.test(text)) {
    return { maxRate: scale(95), typicalRate: scale(78), maxHoursPerUnit: 12 };
  }
  if (/plumb|toilet|faucet|drain|pipe|water heater/i.test(text)) {
    return { maxRate: scale(95), typicalRate: scale(80), maxHoursPerUnit: 10 };
  }
  if (/hvac|furnace|ac unit|air condition/i.test(text)) {
    return { maxRate: scale(105), typicalRate: scale(88), maxHoursPerUnit: 14 };
  }
  if (/roof|shingle|gutter/i.test(text)) {
    return { maxRate: scale(85), typicalRate: scale(70), maxHoursPerUnit: 16 };
  }
  if (
    /screen\s*door|door\s*(?:handle|knob|latch|lever|hinge|lockset)|handle\s*on\s*(?:the\s*)?(?:screen|storm)\s*door/i.test(
      text
    ) &&
    !/full\s*door|new\s*door|prehung|entry\s*door\s*install/i.test(text)
  ) {
    return { maxRate: scale(72), typicalRate: scale(58), maxHoursPerUnit: 2.5 };
  }
  if (/paint|drywall|texture|mud|tape/i.test(text)) {
    return { maxRate: scale(75), typicalRate: scale(62), maxHoursPerUnit: 20 };
  }
  if (/floor|tile|laminate|hardwood|carpet/i.test(text)) {
    return { maxRate: scale(80), typicalRate: scale(68), maxHoursPerUnit: 24 };
  }
  if (/fence|deck|concrete|mason|paver/i.test(text)) {
    return { maxRate: scale(78), typicalRate: scale(65), maxHoursPerUnit: 24 };
  }
  return { maxRate: scale(72), typicalRate: scale(58), maxHoursPerUnit: 8 };
}

function buildLaborFromGuide(
  labor: Partial<LaborBreakdown>,
  guide: JobLaborGuide,
  jobDescription: string,
  suggestedQty: number,
  laborMultiplier = 1,
  perUnitLaborTotal?: number
): LaborBreakdown {
  const { maxRate, typicalRate } = detectLaborRateCap(jobDescription, laborMultiplier);
  let hours = Number(labor.hours) || 0;
  let rate = Number(labor.rate) || 0;

  if (hours < guide.minHours) hours = guide.expectedHours;
  if (hours > guide.maxHours) hours = guide.maxHours;
  if (rate <= 0) rate = typicalRate;
  if (rate > maxRate) rate = maxRate;
  if (rate < 40) rate = typicalRate;

  const jobLaborCost = roundMoney(hours * rate);
  let total = jobLaborCost;
  const qty = Math.max(1, suggestedQty);

  // Per-unit line price: store labor $ per unit in total, keep full-job hours.
  if (guide.isMultiUnit && perUnitLaborTotal != null) {
    total = roundMoney(perUnitLaborTotal);
  } else if (guide.isMultiUnit && qty > 1) {
    total = roundMoney(jobLaborCost / qty);
  }

  return {
    description: String(labor.description || 'Labor').trim(),
    hours: roundMoney(hours),
    rate: roundMoney(rate),
    total,
  };
}

function normalizeLaborBreakdown(
  labor: LaborBreakdown | null,
  jobDescription: string,
  suggestedQty: number,
  laborMultiplier = 1,
  unit = ''
): LaborBreakdown | null {
  // Always produce labor for a real quote — AI sometimes omits laborBreakdown entirely
  const guide = estimateJobLaborHours(jobDescription, suggestedQty, unit);
  const seed: Partial<LaborBreakdown> = labor || {
    description: 'Labor',
    hours: 0,
    rate: 0,
    total: 0,
  };
  return buildLaborFromGuide(seed, guide, jobDescription, suggestedQty, laborMultiplier);
}

/**
 * Final price = materials + realistic labor (hours × rate), then blended with
 * AI + known task market bands so unit jobs are not wildly over/under priced.
 */
function finalizeLaborAndPrice(
  materials: MaterialLine[],
  labor: LaborBreakdown | null,
  jobDescription: string,
  suggestedQty: number,
  unit: string,
  laborMultiplier = 1,
  aiUnitPrice?: number,
  regional?: ReturnType<typeof resolveRegionalPricing>
): { materials: MaterialLine[]; labor: LaborBreakdown | null; unitPrice: number } {
  const guide = estimateJobLaborHours(jobDescription, suggestedQty, unit);
  const { typicalRate, maxRate } = detectLaborRateCap(jobDescription, laborMultiplier);
  const qty = Math.max(1, suggestedQty);

  let lab =
    labor ||
    buildLaborFromGuide(
      { description: 'Labor', hours: 0, rate: 0, total: 0 },
      guide,
      jobDescription,
      qty,
      laborMultiplier
    );

  let hours = Number(lab.hours) || 0;
  // Soft clamp: prefer AI hours when inside the guide band; only replace when absurd
  if (hours <= 0) hours = guide.expectedHours;
  else if (hours < guide.minHours * 0.5) hours = guide.minHours;
  else if (hours < guide.minHours) hours = roundMoney((hours + guide.expectedHours) / 2);
  else if (hours > guide.maxHours * 1.25) hours = guide.maxHours;
  else if (hours > guide.maxHours) hours = roundMoney((hours + guide.maxHours) / 2);

  let rate = Number(lab.rate) || 0;
  if (rate <= 0) rate = typicalRate;
  if (rate > maxRate) rate = maxRate;
  if (rate < 40) rate = typicalRate;

  const jobLaborCost = roundMoney(hours * rate);
  const perUnitLabor = roundMoney(jobLaborCost / qty);

  lab = {
    description: lab.description || 'Labor',
    hours: roundMoney(hours),
    rate: roundMoney(rate),
    total: perUnitLabor,
  };

  let mats = materials.map(m => recalcMaterialLine(m));
  let builtUp = roundMoney(sumMaterialTotals(mats) + perUnitLabor);

  // Blend AI with built-up when both look usable (don't only ever scale UP)
  if (aiUnitPrice && aiUnitPrice > 0 && builtUp > 0) {
    const ratio = aiUnitPrice / builtUp;
    if (ratio >= 0.7 && ratio <= 1.35) {
      // Close enough — average them (slight preference for built-up materials+labor)
      builtUp = roundMoney(builtUp * 0.55 + aiUnitPrice * 0.45);
    } else if (ratio > 1.35 && ratio <= 1.8) {
      // AI higher: partial scale-up (materials may be thin)
      builtUp = roundMoney(builtUp * 0.65 + aiUnitPrice * 0.35);
    } else if (ratio < 0.7 && ratio >= 0.45) {
      // AI lower: partial pull-down (labor guide may have been high)
      builtUp = roundMoney(builtUp * 0.55 + aiUnitPrice * 0.45);
    } else if (ratio > 1.8) {
      // AI much higher: don't fully trust — mild bump only
      builtUp = roundMoney(builtUp * 1.12);
    }
    // ratio < 0.45: ignore AI as likely underquote / bad parse
  }

  // Known fixture/task market band keeps customer charge realistic
  if (regional) {
    const market = blendWithTaskMarket(jobDescription, regional, builtUp * qty);
    // market.total is full job; convert back to per-line unit price
    const marketPerUnit = roundMoney(market.total / qty);
    if (market.band) {
      builtUp = marketPerUnit;
    }
  }

  // Re-scale labor + materials shares to match final unit price
  const matsTotal = sumMaterialTotals(mats);
  const current = roundMoney(matsTotal + lab.total);
  if (current > 0 && Math.abs(current - builtUp) > 0.02) {
    const scale = builtUp / current;
    mats = mats.map(m => {
      const total = roundMoney(m.total * scale);
      const unitPriceLine = m.qty > 0 ? roundMoney(total / m.qty) : total;
      return recalcMaterialLine({ ...m, unitPrice: unitPriceLine, total });
    });
    lab = { ...lab, total: roundMoney(lab.total * scale) };
  }

  const unitPrice = roundMoney(sumMaterialTotals(mats) + (lab?.total || 0));
  return { materials: mats, labor: lab, unitPrice };
}

function buildAlignedQuoteBreakdown(
  materials: MaterialLine[],
  labor: LaborBreakdown | null,
  jobDescription: string,
  unitPrice: number,
  suggestedQty: number,
  unit: string,
  regional: ReturnType<typeof resolveRegionalPricing>
) {
  const guide = estimateJobLaborHours(jobDescription, suggestedQty, unit);
  const { typicalRate, maxRate } = detectLaborRateCap(jobDescription, regional.laborMultiplier);
  return alignBreakdownToUnitPrice(materials, labor, unitPrice, {
    jobDescription,
    suggestedQty,
    unit,
    materialMultiplier: regional.materialMultiplier,
    typicalLaborRate: typicalRate,
    maxLaborRate: maxRate,
    expectedLaborHours: guide.expectedHours,
  });
}

/** Scale material + labor dollar amounts so they always sum to the line unit price. */
function reconcileBuiltUpPrice(
  materials: MaterialLine[],
  labor: LaborBreakdown | null,
  options: {
    aiUnitPrice?: number;
    suggestedQty?: number;
  } = {}
): { materials: MaterialLine[]; labor: LaborBreakdown | null; unitPrice: number } {
  const suggestedQty = Math.max(1, options.suggestedQty || 1);
  const aiUnitPrice =
    typeof options.aiUnitPrice === 'number' && options.aiUnitPrice > 0
      ? roundMoney(options.aiUnitPrice)
      : undefined;

  let mats = materials.map(m => recalcMaterialLine(m));
  let lab = labor;

  let materialsTotal = sumMaterialTotals(mats);
  let laborTotal = roundMoney(lab?.total || 0);
  let builtUp = roundMoney(materialsTotal + laborTotal);

  // AI often returns full-job material $ for qty>1 while unitPrice is per-unit — detect and compress.
  const looksLikeFullJobBreakdown =
    suggestedQty > 1 &&
    builtUp > (aiUnitPrice || builtUp) * 1.25 &&
    (aiUnitPrice
      ? Math.abs(builtUp - aiUnitPrice * suggestedQty) < Math.abs(builtUp - aiUnitPrice)
      : builtUp > suggestedQty * 50);

  if (looksLikeFullJobBreakdown) {
    mats = mats.map(m => {
      const qtyLooksLikeFullScope = m.qty >= suggestedQty * 0.75;
      const nextQty = qtyLooksLikeFullScope && m.qty > 1 ? roundMoney(m.qty / suggestedQty) : m.qty;
      const nextTotal = roundMoney(m.total / suggestedQty);
      const nextUnitPrice = nextQty > 0 ? roundMoney(nextTotal / nextQty) : nextTotal;
      return recalcMaterialLine({ ...m, qty: Math.max(nextQty, 0.01), unitPrice: nextUnitPrice, total: nextTotal });
    });
    if (lab) {
      const scaledLaborTotal = roundMoney(lab.total / suggestedQty);
      lab = { ...lab, total: scaledLaborTotal };
    }
    materialsTotal = sumMaterialTotals(mats);
    laborTotal = roundMoney(lab?.total || 0);
    builtUp = roundMoney(materialsTotal + laborTotal);
  }

  if (builtUp <= 0 && aiUnitPrice) {
    const matShare = roundMoney(aiUnitPrice * 0.55);
    const labShare = roundMoney(aiUnitPrice - matShare);
    mats = [
      {
        description: 'Materials & supplies',
        qty: 1,
        unit: 'lot',
        unitPrice: matShare,
        total: matShare,
      },
    ];
    lab = {
      description: 'Labor',
      hours: 0,
      rate: 0,
      total: labShare,
    };
    builtUp = aiUnitPrice;
  }

  const unitPrice = roundMoney(sumMaterialTotals(mats) + roundMoney(lab?.total || 0));
  return { materials: mats, labor: lab, unitPrice };
}

/** Keep client-facing material lists tight and realistic; merge overflow into one misc line. */
function normalizeMaterialsList(raw: MaterialLine[], maxLines = 8): MaterialLine[] {
  const cleaned = raw
    .filter(m => m.description.trim().length > 0)
    .map(m => {
      const qty = Number.isFinite(m.qty) && m.qty > 0 ? m.qty : 1;
      const unitPrice = roundMoney(Number(m.unitPrice) || 0);
      const total = roundMoney(Number.isFinite(m.total) ? m.total : qty * unitPrice);
      return {
        description: m.description.trim(),
        qty,
        unit: m.unit?.trim() || 'ea',
        unitPrice,
        total,
      };
    })
    .filter(m => m.total > 0 || m.unitPrice > 0);

  if (cleaned.length <= maxLines) return cleaned;

  const sorted = [...cleaned].sort((a, b) => b.total - a.total);
  const kept = sorted.slice(0, maxLines - 1);
  const merged = sorted.slice(maxLines - 1);
  const miscTotal = roundMoney(merged.reduce((sum, m) => sum + m.total, 0));

  if (miscTotal > 0) {
    kept.push({
      description: 'Misc. supplies & consumables',
      qty: 1,
      unit: 'lot',
      unitPrice: miscTotal,
      total: miscTotal,
    });
  }

  return kept;
}

/** Merge multiple minor consumable lines into one misc line. */
function consolidateSmallConsumables(materials: MaterialLine[]): MaterialLine[] {
  const consumables = materials.filter(
    m => m.total < 20 && MISC_SUPPLY_PATTERNS.test(m.description)
  );
  const nonConsumables = materials.filter(
    m => !(m.total < 20 && MISC_SUPPLY_PATTERNS.test(m.description))
  );
  if (consumables.length < 2) return materials;

  const miscTotal = roundMoney(consumables.reduce((sum, m) => sum + m.total, 0));
  return [
    ...nonConsumables,
    {
      description: 'Misc. fasteners & supplies',
      qty: 1,
      unit: 'lot',
      unitPrice: miscTotal,
      total: miscTotal,
    },
  ];
}

/** Drop redundant low-cost consumable lines when the list is still too long. */
function trimRedundantConsumables(materials: MaterialLine[], targetMax = 7): MaterialLine[] {
  if (materials.length <= targetMax) return materials;

  const significant = materials.filter(m => m.total >= 15 || !MISC_SUPPLY_PATTERNS.test(m.description));
  const consumables = materials.filter(m => m.total < 15 && MISC_SUPPLY_PATTERNS.test(m.description));

  if (consumables.length === 0) return normalizeMaterialsList(materials, targetMax);

  const miscTotal = roundMoney(consumables.reduce((sum, m) => sum + m.total, 0));
  const merged: MaterialLine[] = [...significant];
  if (miscTotal > 0) {
    merged.push({
      description: 'Misc. fasteners & supplies',
      qty: 1,
      unit: 'lot',
      unitPrice: miscTotal,
      total: miscTotal,
    });
  }

  return normalizeMaterialsList(merged, targetMax);
}

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

  const { data: { user }, error } = await supabase.auth.getUser();
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

export async function POST(request: NextRequest) {
  try {
    // 1. Auth check
    const { user, error: authError } = await verifyUser(request);
    if (!user) {
      return NextResponse.json({ error: authError || 'Unauthorized' }, { status: 401 });
    }

    // 2. Basic rate limiting (demo - see comment above)
    const rateCheck = checkRateLimit(user.id);
    if (!rateCheck.allowed) {
      return NextResponse.json(
        { error: `Rate limit exceeded. Try again in ${rateCheck.retryAfter} seconds.` },
        { status: 429, headers: { 'Retry-After': String(rateCheck.retryAfter) } }
      );
    }

    const apiKey = getXaiApiKey();
    if (!apiKey) {
      return NextResponse.json({ error: 'GROK_API_KEY is missing! In Vercel: Settings → Environment Variables → Add New. In the "Key" field type exactly: GROK_API_KEY. In the "Value" field paste the real key from https://console.x.ai/. Select Production and Save. Then redeploy.' }, { status: 500 });
    }

    const body = await request.json();
    let jobDescription = String(body?.description || '').trim();
    const imageBase64 = typeof body?.imageBase64 === 'string' ? body.imageBase64 : undefined;
    const imageUrl = typeof body?.imageUrl === 'string' ? body.imageUrl : undefined;
    let imageAnalysis: JobImageAnalysis | null = null;

    if (imageBase64 || imageUrl) {
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
      return NextResponse.json({
        error: imageBase64 || imageUrl
          ? 'Could not extract enough scope from the photo. Add a short text note and try again.'
          : 'Description must be at least 3 characters, or upload a job photo.',
      }, { status: 400 });
    }

    const jobLocation = (body?.jobLocation || body?.location) as QuoteLocationInput | undefined;
    const companyLocation = body?.companyLocation as QuoteLocationInput | undefined;
    const lineContext = body?.lineContext as QuoteLineContext | undefined;
    const priceMemory: AiPriceMemory = normalizeAiPriceMemory(body?.priceMemory);
    const priceMemoryPrompt = formatPriceMemoryForPrompt(priceMemory);
    const regional = resolveRegionalPricing(jobLocation, companyLocation);

    const applyMemoryAndAlign = (
      materialsIn: MaterialLine[],
      laborIn: LaborBreakdown | null,
      jobDesc: string,
      unitPrice: number,
      qty: number,
      unit: string
    ) => {
      const applied = applyPriceMemoryToBreakdown(materialsIn, laborIn, priceMemory);
      // Prefer contractor unit prices: rebuild line unit price from materials + labor when memory applied
      let nextUnitPrice = unitPrice;
      if (applied.appliedMaterialCount > 0 || applied.appliedLaborRate) {
        const matSum = sumMaterialTotals(applied.materials);
        const labSum = applied.labor?.total || 0;
        const built = roundMoney(matSum + labSum);
        if (built > 0) nextUnitPrice = built;
      }
      const aligned = buildAlignedQuoteBreakdown(
        applied.materials,
        applied.labor,
        jobDesc,
        nextUnitPrice,
        qty,
        unit,
        regional
      );
      return {
        aligned,
        appliedMaterialCount: applied.appliedMaterialCount,
        appliedLaborRate: applied.appliedLaborRate,
        unitPrice: nextUnitPrice,
      };
    };

    const anchoredQuote = computePricingAnchor(jobDescription, regional);
    if (anchoredQuote) {
      const structured = resolveQuoteLineStructure(jobDescription, regional, {
        suggestedQty: anchoredQuote.suggestedQty,
        unit: anchoredQuote.unit,
        unitPrice: anchoredQuote.unitPrice,
        total: anchoredQuote.total,
      });
      const { aligned, appliedMaterialCount, appliedLaborRate, unitPrice: memUnitPrice } =
        applyMemoryAndAlign(
          anchoredQuote.materials,
          anchoredQuote.laborBreakdown,
          jobDescription,
          structured.unitPrice,
          structured.suggestedQty,
          structured.unit
        );
      const finalUnit = memUnitPrice > 0 ? memUnitPrice : structured.unitPrice;
      const finalTotal = roundMoney(finalUnit * structured.suggestedQty);
      return NextResponse.json({
        unitPrice: finalUnit,
        unit: structured.unit,
        suggestedQty: structured.suggestedQty,
        total: finalTotal,
        billingMode: structured.billingMode,
        breakdown: anchoredQuote.breakdown,
        confidence: anchoredQuote.confidence,
        materials: aligned.materials,
        materialsCostTotal: aligned.materialsCostTotal,
        laborCostTotal: aligned.laborCostTotal,
        laborBreakdown: aligned.labor,
        pricingMethod: 'deterministic',
        jobMaterialsTotal: aligned.materialsCostTotal,
        jobLaborTotal: aligned.laborCostTotal,
        analyzedScope: imageAnalysis?.scopeDescription,
        imageAnalysis,
        priceMemoryApplied: {
          materials: appliedMaterialCount,
          laborRate: appliedLaborRate,
        },
        pricingRegion: {
          label: regional.label,
          source: regional.source,
          costTier: regional.costTier,
          materialMultiplier: regional.materialMultiplier,
          laborMultiplier: regional.laborMultiplier,
        },
      });
    }

    const regionalPrompt = buildRegionalPromptSection(regional);
    const userMessage = buildQuoteUserMessage(
      jobDescription,
      regional,
      lineContext,
      jobLocation
    );

    const response = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: getXaiChatModel(),
        messages: [
          {
            role: 'system',
            content: `You are a professional residential contractor estimator. Your quotes must match what a real local contractor would charge a homeowner for the EXACT task described — competitive mid-market, not luxury and not a giveaway.

PRICING ONLY — do not rewrite the customer-facing description. Price only what is written (no extras, no "while we're there" work).

Return ONLY valid JSON.

${regionalPrompt}

${priceMemoryPrompt ? `\n${priceMemoryPrompt}\n` : ''}

ACCURACY RULES (critical — quotes are often too high or too low when ignored):
1) Scope lock: Price ONLY the described task. If they say "replace toilet", do not include bathroom remodel, tile, or vanity.
2) MATERIALS = Lowe's.com mid-grade shelf prices (what a homeowner pays walking into Lowe's). LABOR is separate hours × rate.
3) unitPrice for Unit jobs = FULL job total the customer pays for that one task (materials + labor). For SF jobs = price PER square foot installed.
4) Prefer realistic mid-market installed prices. If unsure, stay near typical homeowner-facing contractor pricing for 2025–2026.

${formatLowesPriceGuideForPrompt()}

TYPICAL INSTALLED TOTALS (Unit jobs = Lowe's materials + labor — adjust ±15–25% for the regional factors above):
- Screen/storm door handle or door knob/latch: $150–$400 | single outlet/switch/GFCI: $150–$450
- Faucet repair/cartridge: $150–$450 | new faucet install: $220–$550 | toilet replace: $350–$750
- Garbage disposal: $300–$650 | ceiling fan: $220–$550 | light fixture swap: $160–$450
- Interior prehung door: $280–$650 | entry door: $900–$2,800 | single window: $550–$1,600
- Drywall small patch: $175–$500 | water heater (tank): $1,200–$2,800
- Dishwasher install: $250–$550 | vanity install: $450–$1,400

LABOR HOURS (total crew-hours for the WHOLE task — not per sqft unless SF billing):
- Small hardware / outlet / fixture swap: 0.75–3 hrs
- Toilet, faucet install, disposal, fan: 1.5–4 hrs
- Interior door / drywall patch: 1.5–5 hrs
- Entry door / water heater: 3–10 hrs
- Roof: ~1.5–3.5 hrs per square (100 sqft). Flooring: ~1 hr per 25–35 sqft. Whole-home paint: use paintable wall+ceiling area (~3–4× floor sqft), not floor alone.
- NEVER assign 8–20 hours to a single toilet, faucet, handle, or outlet.

PRICING METHODOLOGY:
- Material unitPrice MUST match Lowe's.com mid-grade (Good/Better aisle), NOT Home Depot Pro, NOT specialty showroom, NOT installed package prices.
- Do NOT add contractor material markup into materials[] — materials are pure retail shelf cost; profit is only in the labor rate if at all.
- Do NOT add overhead, profit pad, contingency, or permits into unitPrice — direct Lowe's materials + direct labor only.
- laborBreakdown.hours = TOTAL crew-hours for the entire scope described.
- Do not under-quote large area work (roof, whole-house paint, full flooring).

MATERIALS LIST (client-facing — must match the quoted scope):
- Include ONLY materials directly required to complete the described work. No extras, no "just in case" items.
- Quantities must fit the actual job size in the description. Do not over-order or assume maximum/worst-case scope.
- Do NOT list every fastener, tape, primer, connector, or consumable separately. Group minor items into one line when needed (e.g. "Misc. fasteners & supplies").
- Do NOT add separate waste-factor or contingency line items; bake normal waste (about 5–10%) into quantities quietly.
- Typical line items: 3–6 materials. Simple jobs: 2–4. Complex jobs: up to 8 maximum.
- Each material line needs: description (specific name/size as sold at Lowe's), qty, unit, unitPrice (Lowe's shelf), total.
- Skip materials that are negligible cost or not meaningful to show the client.
- Name materials the way Lowe's labels them when possible (e.g. "1/2 in. x 4 ft. x 8 ft. Drywall Sheet", "Architectural Shingles Bundle").

PRICING MATH (strict — numbers must reconcile):
- BILLING MODE (critical): If the job can be measured in square feet (paint, roof, flooring, drywall, siding, stucco, insulation), set suggestedQty = total sqft, unit = "SF", unitPrice = mid-market local installed $/sqft. All other jobs (fixtures, small installs, lump-sum): suggestedQty = 1, unit = "Unit", unitPrice = full job total.
- unitPrice = rate per SF or full Unit price BEFORE multiplying by suggestedQty.
- materialsCostTotal + laborCostTotal MUST EXACTLY equal unitPrice (to the penny). Never higher, never lower.
- Material line totals must be sized for ONE unit of measure — do NOT put the full multi-qty job cost in materials when suggestedQty > 1.
- laborBreakdown.hours is always the full-job total. laborBreakdown.total is the labor dollars included in ONE unit of unitPrice (divide full-job labor cost by suggestedQty when quoting per sqft).
- laborBreakdown.rate should be consistent: (laborBreakdown.total × suggestedQty) ÷ laborBreakdown.hours ≈ hourly rate.
- total = unitPrice × suggestedQty.
- breakdown: brief internal scope summary for the estimator (no dollar amounts in prose). Do NOT rewrite the customer-facing line description — pricing only.

{
  "unitPrice": number,
  "unit": "sqft|lf|ea|job|gallons|lot|hours|pieces|bags|rolls|sheets|boxes|days|lbs|tons|sq yd|cu yd|ln ft|ft|in",
  "suggestedQty": number,
  "total": number,
  "breakdown": "Scope summary",
  "confidence": "high" | "medium" | "low",
  "materialsCostTotal": number,
  "laborCostTotal": number,
  "materials": [
    { "description": "Primary material name/size", "qty": number, "unit": "ea|sqft|lf|gallons|lbs|bags|rolls|etc", "unitPrice": number, "total": number }
  ],
  "laborBreakdown": {
    "description": "Labor tasks involved",
    "hours": number,
    "rate": number,
    "total": number
  }
}`
          },
          { role: 'user', content: userMessage }
        ],
        temperature: 0,
        max_tokens: 1800,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return NextResponse.json({ error: `xAI API Error: ${errorText}` }, { status: response.status });
    }

    const data = await response.json();
    const aiText = data.choices?.[0]?.message?.content || '';

    const jsonMatch = aiText.match(/\{[\s\S]*\}/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : null;

    if (!parsed) {
      return NextResponse.json({ error: 'AI returned invalid format' }, { status: 500 });
    }

    /** AI often returns numbers as strings — coerce safely */
    const num = (v: unknown, fallback = 0): number => {
      if (typeof v === 'number' && Number.isFinite(v)) return v;
      if (typeof v === 'string') {
        const n = parseFloat(v.replace(/[$,%\s]/g, '').replace(/,/g, ''));
        if (Number.isFinite(n)) return n;
      }
      return fallback;
    };

    const aiTargetUnitPrice = (() => {
      const n = num(parsed.unitPrice, 0);
      return n > 0 ? n : undefined;
    })();

    const rawMaterials = Array.isArray(parsed.materials)
      ? parsed.materials
      : parsed.materialBreakdown
        ? [parsed.materialBreakdown]
        : [];

    const parsedMaterials: MaterialLine[] = rawMaterials
      .filter((m: { description?: string }) => m?.description?.trim())
      .map((m: { description?: string; qty?: number; unit?: string; unitPrice?: number; total?: number }) => {
        const qty = num(m.qty, 1) || 1;
        const unitPrice = num(m.unitPrice, 0);
        const total = num(m.total, 0) || qty * unitPrice;
        return {
          description: String(m.description).trim(),
          qty,
          unit: m.unit ? String(m.unit).trim() : 'ea',
          unitPrice,
          total,
        };
      });

    const suggestedQty = (() => {
      const n = num(parsed.suggestedQty, 1);
      return n > 0 ? n : 1;
    })();

    let materials = trimRedundantConsumables(consolidateSmallConsumables(parsedMaterials));
    materials = calibrateMaterialPrices(materials, regional.materialMultiplier);

    const lineUnit = parsed.unit ? String(parsed.unit).trim() : '';

    // Always build a labor object when AI omits laborBreakdown — install work always has labor
    const rawLabor = parsed.laborBreakdown || parsed.labor || null;
    let laborBreakdown = normalizeLaborBreakdown(
      {
        description: String(rawLabor?.description || 'Labor').trim() || 'Labor',
        hours: num(rawLabor?.hours, 0),
        rate: num(rawLabor?.rate, 0),
        total: num(rawLabor?.total, 0),
      },
      jobDescription,
      suggestedQty,
      regional.laborMultiplier,
      lineUnit
    );

    // Apply contractor-edited preferred prices before reconciling totals
    {
      const applied = applyPriceMemoryToBreakdown(materials, laborBreakdown, priceMemory);
      materials = applied.materials as MaterialLine[];
      laborBreakdown = applied.labor;
    }

    const reconciled = reconcileBuiltUpPrice(materials, laborBreakdown, {
      aiUnitPrice: aiTargetUnitPrice,
      suggestedQty,
    });

    const finalized = finalizeLaborAndPrice(
      reconciled.materials,
      reconciled.labor,
      jobDescription,
      suggestedQty,
      lineUnit,
      regional.laborMultiplier,
      aiTargetUnitPrice,
      regional
    );
    materials = finalized.materials;
    laborBreakdown = finalized.labor;

    // Re-apply memory after finalize so labor rate / material unit prices stick
    const memoryPass = applyPriceMemoryToBreakdown(materials, laborBreakdown, priceMemory);
    materials = memoryPass.materials as MaterialLine[];
    laborBreakdown = memoryPass.labor;
    let memoryUnitPrice = finalized.unitPrice;
    if (memoryPass.appliedMaterialCount > 0 || memoryPass.appliedLaborRate) {
      const built = roundMoney(sumMaterialTotals(materials) + (laborBreakdown?.total || 0));
      if (built > 0) memoryUnitPrice = built;
    }

    const materialsCostTotal = sumMaterialTotals(materials);
    const laborCostTotal = roundMoney(laborBreakdown?.total || 0);
    const structured = resolveQuoteLineStructure(jobDescription, regional, {
      suggestedQty,
      unit: lineUnit || parsed.unit,
      unitPrice: memoryUnitPrice,
      total: roundMoney(memoryUnitPrice * suggestedQty),
    });

    if (structured.unitPrice <= 0 || structured.total <= 0) {
      return NextResponse.json({ error: 'AI could not produce a valid price for this description' }, { status: 500 });
    }

    let aligned = buildAlignedQuoteBreakdown(
      materials,
      laborBreakdown,
      jobDescription,
      structured.unitPrice,
      structured.suggestedQty,
      structured.unit,
      regional
    );

    // Final pass: lock contractor-preferred material unit prices + labor rate into the response
    const finalMem = applyPriceMemoryToBreakdown(
      aligned.materials,
      aligned.labor,
      priceMemory
    );
    if (finalMem.appliedMaterialCount > 0 || finalMem.appliedLaborRate) {
      const matSum = sumMaterialTotals(finalMem.materials);
      const labSum = finalMem.labor?.total || 0;
      const built = roundMoney(matSum + labSum);
      aligned = {
        ...aligned,
        materials: finalMem.materials as MaterialLine[],
        labor: finalMem.labor,
        materialsCostTotal: matSum,
        laborCostTotal: labSum,
      };
      if (built > 0) {
        structured.unitPrice = built;
        structured.total = roundMoney(built * structured.suggestedQty);
      }
    }

    return NextResponse.json({
      unitPrice: structured.unitPrice,
      unit: structured.unit,
      suggestedQty: structured.suggestedQty,
      total: structured.total,
      billingMode: structured.billingMode,
      breakdown: parsed.breakdown,
      confidence: parsed.confidence,
      materials: aligned.materials,
      materialsCostTotal: aligned.materialsCostTotal,
      laborCostTotal: aligned.laborCostTotal,
      laborBreakdown: aligned.labor,
      analyzedScope: imageAnalysis?.scopeDescription,
      imageAnalysis,
      priceMemoryApplied: {
        materials: finalMem.appliedMaterialCount,
        laborRate: finalMem.appliedLaborRate,
      },
      pricingRegion: {
        label: regional.label,
        source: regional.source,
        costTier: regional.costTier,
        materialMultiplier: regional.materialMultiplier,
        laborMultiplier: regional.laborMultiplier,
      },
    });
  } catch (error: any) {
    console.error(error);
    return NextResponse.json({ error: error.message || 'Server error' }, { status: 500 });
  }
}