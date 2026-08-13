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
import { detectWholeHomeInteriorPaint, estimateInteriorPaintableSqft } from '@/lib/ai-quote-anchor';
import {
  coercePerUnitPrice,
  getMarketSqftUnitPrice,
  detectSqftBillingContext,
  resolveQuoteLineStructure,
  parseSqftFromDescription,
} from '@/lib/quote-units';
import { analyzeJobImage, type JobImageAnalysis } from '@/lib/analyze-job-image';
import { getXaiApiKey, getXaiQuoteModel } from '@/lib/xai-config';
import { buildCalculatorQuoteAnchor } from '@/lib/buildcalculator';
import {
  applyEpMultiplierToBuildCalcBase,
  detectEstimationProTrade,
  fetchEstimationProMultiplier,
  fetchEstimationProTradeCosts,
  pickPaintLaborBand,
  type PriceRange,
} from '@/lib/estimationpro';
import {
  applyMaterialMarkup,
  calibrateMaterialPrices,
  DEFAULT_MATERIAL_MARKUP,
  recalcMaterialLine,
  sumMaterialTotals,
  type MarketMaterialLine,
} from '@/lib/market-material-caps';
import { formatLowesPriceGuideForPrompt } from '@/lib/lowes-material-prices';
import {
  correctMaterialQuantities,
  ensureCoverageMaterials,
} from '@/lib/material-quantities';
import {
  estimateIndustryLabor,
  formatIndustryLaborPrompt,
} from '@/lib/industry-labor-engine';
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

  // 1) Specific unit tasks first (toilet, outlet, faucet, door handle, …)
  const qty = Math.max(1, scope.scopeQty);
  const unitGuide = estimateUnitJobLaborHours(description);
  if (unitGuide) {
    const minH = unitGuide.minHours * Math.min(qty, 4);
    const expH = unitGuide.expectedHours * Math.min(qty, 4);
    const maxH = unitGuide.maxHours * Math.min(qty, 6);
    if (qty > 4) {
      const extra = (qty - 4) * unitGuide.expectedHours * 0.75;
      return finish(minH + extra * 0.6, expH + extra, maxH + extra * 1.1);
    }
    return finish(minH, expH, maxH);
  }

  // 2) Multi-industry phase engine (drywall, paint, roof, floor, fence, …)
  const industry = estimateIndustryLabor(description, suggestedQty, unit);
  if (industry) {
    return finish(industry.minHours, industry.expectedHours, industry.maxHours);
  }

  // 3) Whole-home interior paint (floor sqft → paintable area)
  const wholeHomePaint = detectWholeHomeInteriorPaint(description);
  if (wholeHomePaint) {
    const paintableSqft = estimateInteriorPaintableSqft(
      wholeHomePaint.floorSqft,
      wholeHomePaint.ceilingFt
    );
    const coats = wholeHomePaint.coats;
    const production = coats === 1 ? 110 : coats === 2 ? 75 : 55;
    let exp = paintableSqft / production;
    // Int+ext of same home — more surface, not infinite
    if (/exterior/i.test(description) && /interior/i.test(description)) {
      exp *= 1.45;
    }
    // Absolute residential cap (crew-hours)
    exp = Math.min(exp, Math.max(24, wholeHomePaint.floorSqft / 15));
    return finish(exp * 0.8, exp, Math.min(exp * 1.35, 160));
  }

  // Fallback by measure
  if (scope.measure === 'sqft') {
    const sqft = Math.max(1, scope.scopeQty);
    return finish(sqft / 40, sqft / 25, sqft / 15);
  }
  if (scope.measure === 'lf') {
    const lf = scope.scopeQty;
    return finish(lf / 15, lf / 10, lf / 6);
  }

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
  laborMultiplier = 1,
  preferredLaborRate?: number
): { maxRate: number; typicalRate: number; maxHoursPerUnit: number } {
  const scale = (n: number) => roundMoney(n * laborMultiplier);
  // Contractor-edited rate always wins as the typical (and expands the cap)
  if (preferredLaborRate && preferredLaborRate >= 10 && preferredLaborRate <= 500) {
    const industry = estimateIndustryLabor(description, 1, '');
    const baseMax = industry ? industry.maxRate : 95;
    return {
      typicalRate: roundMoney(preferredLaborRate),
      maxRate: roundMoney(Math.max(scale(baseMax), preferredLaborRate * 1.15, preferredLaborRate)),
      maxHoursPerUnit: industry ? Math.max(8, industry.maxHours) : 24,
    };
  }
  // Prefer industry engine rates when trade is known
  const industry = estimateIndustryLabor(description, 1, '');
  if (industry) {
    return {
      maxRate: scale(industry.maxRate),
      typicalRate: scale(industry.typicalRate),
      maxHoursPerUnit: Math.max(8, industry.maxHours),
    };
  }
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
  perUnitLaborTotal?: number,
  preferredLaborRate?: number
): LaborBreakdown {
  const { maxRate, typicalRate } = detectLaborRateCap(
    jobDescription,
    laborMultiplier,
    preferredLaborRate
  );
  let hours = Number(labor.hours) || 0;
  let rate = Number(labor.rate) || 0;

  if (hours < guide.minHours) hours = guide.expectedHours;
  if (hours > guide.maxHours) hours = guide.maxHours;
  // Absolute guard: never allow fantasy multi-thousand hour paint jobs
  const absHourCap = /paint|painting/i.test(jobDescription)
    ? Math.min(180, Math.max(guide.maxHours, 48))
    : Math.min(500, Math.max(guide.maxHours * 1.2, 80));
  if (hours > absHourCap) hours = absHourCap;
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
  unit = '',
  preferredLaborRate?: number
): LaborBreakdown | null {
  // Always produce labor for a real quote — AI sometimes omits laborBreakdown entirely
  const guide = estimateJobLaborHours(jobDescription, suggestedQty, unit);
  const seed: Partial<LaborBreakdown> = labor || {
    description: 'Labor',
    hours: 0,
    rate: 0,
    total: 0,
  };
  return buildLaborFromGuide(
    seed,
    guide,
    jobDescription,
    suggestedQty,
    laborMultiplier,
    undefined,
    preferredLaborRate
  );
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
  regional?: ReturnType<typeof resolveRegionalPricing>,
  preferredLaborRate?: number
): { materials: MaterialLine[]; labor: LaborBreakdown | null; unitPrice: number } {
  const guide = estimateJobLaborHours(jobDescription, suggestedQty, unit);
  const { typicalRate, maxRate } = detectLaborRateCap(
    jobDescription,
    laborMultiplier,
    preferredLaborRate
  );
  const qty = Math.max(1, suggestedQty);

  let lab =
    labor ||
    buildLaborFromGuide(
      { description: 'Labor', hours: 0, rate: 0, total: 0 },
      guide,
      jobDescription,
      qty,
      laborMultiplier,
      undefined,
      preferredLaborRate
    );

  let hours = Number(lab.hours) || 0;
  // Soft clamp: prefer AI hours when inside the guide band; only replace when absurd
  if (hours <= 0) hours = guide.expectedHours;
  else if (hours < guide.minHours * 0.5) hours = guide.minHours;
  else if (hours < guide.minHours) hours = roundMoney((hours + guide.expectedHours) / 2);
  else if (hours > guide.maxHours * 1.25) hours = guide.maxHours;
  else if (hours > guide.maxHours) hours = roundMoney((hours + guide.maxHours) / 2);

  // Contractor-saved rate wins over industry defaults
  let rate = preferredLaborRate && preferredLaborRate >= 10
    ? preferredLaborRate
    : Number(lab.rate) || 0;
  if (rate <= 0) rate = typicalRate;
  if (rate > maxRate) rate = maxRate;
  if (rate < 10) rate = typicalRate;

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
  regional: ReturnType<typeof resolveRegionalPricing>,
  preferredLaborRate?: number
) {
  const guide = estimateJobLaborHours(jobDescription, suggestedQty, unit);
  const { typicalRate, maxRate } = detectLaborRateCap(
    jobDescription,
    regional.laborMultiplier,
    preferredLaborRate
  );
  return alignBreakdownToUnitPrice(materials, labor, unitPrice, {
    jobDescription,
    suggestedQty,
    unit,
    materialMultiplier: regional.materialMultiplier,
    typicalLaborRate: preferredLaborRate && preferredLaborRate >= 10 ? preferredLaborRate : typicalRate,
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

  /*
   * SF-billed jobs: unitPrice is per SF, but materials must stay FULL-JOB physical counts
   * (e.g. 7 drywall sheets for 200 SF — NEVER 7/200 = 0.035 sheets).
   * Only convert DOLLAR totals to per-unit for labor residual math; never divide sheet/ea qty by SF.
   */
  const looksLikeFullJobBreakdown =
    suggestedQty > 1 &&
    builtUp > (aiUnitPrice || builtUp) * 1.25 &&
    (aiUnitPrice
      ? Math.abs(builtUp - aiUnitPrice * suggestedQty) < Math.abs(builtUp - aiUnitPrice)
      : builtUp > suggestedQty * 50);

  if (looksLikeFullJobBreakdown) {
    const physicalUnit = /sheet|ea|each|bag|bundle|roll|box|pc|piece|gallon|gal|kit|set/i;
    mats = mats.map((m) => {
      const isPhysical =
        physicalUnit.test(m.unit || '') ||
        /drywall|sheetrock|stud|toilet|faucet|door|window|shingle|paint|gallon/i.test(
          m.description || ''
        );
      if (isPhysical) {
        // Keep full-job qty + Lowe's unit price; total = qty × unitPrice (full job)
        return recalcMaterialLine(m);
      }
      // Soft goods priced per SF already — optional light pass-through
      return recalcMaterialLine(m);
    });
    // Labor total may be full-job; convert labor $ to per-unit for unitPrice build-up
    if (lab && lab.total > (aiUnitPrice || 0) * 1.5) {
      lab = { ...lab, total: roundMoney(lab.total / suggestedQty) };
    }
    // For unit price, materials share is fullJobMaterials / suggestedQty
    const fullMat = sumMaterialTotals(mats);
    const perUnitMat = roundMoney(fullMat / suggestedQty);
    // Represent as single blended materials lot per SF only for unitPrice math path —
    // actual line items kept full-job below via correctMaterialQuantities after finalize.
    // Store per-unit dollars on a shadow scale by reducing totals only for builtUp calc:
    builtUp = roundMoney(perUnitMat + roundMoney(lab?.total || 0));
    materialsTotal = fullMat;
    laborTotal = roundMoney(lab?.total || 0);
    // Keep mats as full-job physical lines (do not replace with fractional qtys)
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
    const preferredLaborRate = priceMemory.laborRate;
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
        if (built > 0) {
          // built is full-job $; for SF qty convert to per-unit so we don't do job$ × sqft
          nextUnitPrice =
            qty > 1 ? roundMoney(built / qty) : built;
        }
      }
      const sqftCtx = detectSqftBillingContext(jobDesc, qty, unit);
      const market =
        sqftCtx != null ? getMarketSqftUnitPrice(sqftCtx, regional) : undefined;
      nextUnitPrice = coercePerUnitPrice(nextUnitPrice, qty, {
        marketUnitPrice: market,
        description: jobDesc,
      });
      const aligned = buildAlignedQuoteBreakdown(
        applied.materials,
        applied.labor,
        jobDesc,
        nextUnitPrice,
        qty,
        unit,
        regional,
        preferredLaborRate
      );
      return {
        aligned,
        appliedMaterialCount: applied.appliedMaterialCount,
        appliedLaborRate: applied.appliedLaborRate,
        unitPrice: nextUnitPrice,
      };
    };

    // BuildCalculator unit costs (base) + EstimationPro regional multiplier → low/typical/high
    const zipForEp =
      String(jobLocation?.zipCode || companyLocation?.zipCode || '').replace(/\D/g, '').slice(0, 5) ||
      '';
    const stateForEp = String(jobLocation?.state || companyLocation?.state || '')
      .trim()
      .toUpperCase()
      .slice(0, 2);

    const [bcAnchor, epMultiplier, epTradeCosts] = await Promise.all([
      // Do NOT bake regional into BC — EstimationPro multiplier is applied next
      buildCalculatorQuoteAnchor(jobDescription, { regionalUsdBlend: 1 }),
      fetchEstimationProMultiplier({ zipCode: zipForEp, state: stateForEp }),
      fetchEstimationProTradeCosts({
        trade: detectEstimationProTrade(jobDescription),
        zipCode: zipForEp,
        state: stateForEp,
      }),
    ]);

    const epMult = epMultiplier?.multiplier || epTradeCosts?.multiplier || 1;
    const epLaborBand = pickPaintLaborBand(epTradeCosts, jobDescription);
    let priceRange: PriceRange | null = null;
    if (bcAnchor?.baseUnitCostUsd != null && bcAnchor.billingQuantity != null) {
      priceRange = applyEpMultiplierToBuildCalcBase({
        baseUnitCostUsd: bcAnchor.baseUnitCostUsd,
        quantity: bcAnchor.billingQuantity,
        epMultiplier: epMult,
        epLaborPerSf: epLaborBand,
        unitLabel: 'SF',
        spread: 0.18,
      });
    } else if (epLaborBand && bcAnchor?.billingQuantity) {
      // Fallback: EstimationPro labor band only
      const qty = bcAnchor.billingQuantity;
      priceRange = {
        low: Math.round(epLaborBand.low * qty * 100) / 100,
        typical: Math.round(epLaborBand.typical * qty * 100) / 100,
        high: Math.round(epLaborBand.high * qty * 100) / 100,
        perSf: epLaborBand,
        unit: 'SF',
        quantity: qty,
        label: `$${Math.round(epLaborBand.low * qty)} – $${Math.round(epLaborBand.high * qty)} (typical $${Math.round(epLaborBand.typical * qty)})`,
        sources: ['EstimationPro.ai regional labor rates'],
      };
    }

    const epPromptBlock = [
      'ESTIMATIONPRO.AI REGIONAL MULTIPLIER (apply to BuildCalculator base unit costs):',
      epMultiplier
        ? `Location: ${epMultiplier.label || epMultiplier.location} · multiplier ×${epMult.toFixed(2)} (labor ×${(epMultiplier.laborMultiplier || epMult).toFixed(2)})`
        : `No ZIP/state resolved — using national average multiplier ×1.00`,
      priceRange
        ? `PRICE RANGE after BC base × EP multiplier: LOW $${priceRange.low.toFixed(0)} · TYPICAL $${priceRange.typical.toFixed(0)} · HIGH $${priceRange.high.toFixed(0)}${priceRange.perSf ? ` (≈ $${priceRange.perSf.typical.toFixed(2)}/SF typical)` : ''}`
        : '',
      'Your unitPrice × suggestedQty (total) should land near the TYPICAL value, within the LOW–HIGH band.',
      'Attribution: BuildCalculator.io unit costs + EstimationPro.ai regional multipliers.',
    ]
      .filter(Boolean)
      .join('\n');

    // SuperGrok-style path + BuildCalculator base + EstimationPro regional range.

    const regionalPrompt = buildRegionalPromptSection(regional);
    const userMessage = buildQuoteUserMessage(
      jobDescription,
      regional,
      lineContext,
      jobLocation
    );

    const quoteModel = getXaiQuoteModel();
    const response = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: quoteModel,
        temperature: 0.2,
        messages: [
          {
            role: 'system',
            content: `You are Grok — the same caliber of estimator a SuperGrok user gets when they ask for a contractor bid. Give a REALISTIC residential contractor price a homeowner would actually pay in the US mid-market (adjust for the region below).

Think like SuperGrok chat: sensible totals first, then back into materials + labor. Never invent fantasy numbers (e.g. 2,000+ hours for painting a 1,200 SF home, or multi-million dollar paint jobs).

PRICING ONLY — do not rewrite the customer-facing description. Price only what is written (no extras, no "while we're there" work).

Return ONLY valid JSON (no markdown).

${regionalPrompt}

${bcAnchor?.promptBlock ? `\n${bcAnchor.promptBlock}\n` : ''}

${epPromptBlock ? `\n${epPromptBlock}\n` : ''}

${priceMemoryPrompt ? `\n${priceMemoryPrompt}\n` : ''}

PRICING FORMULA (critical — follow exactly):
1) BASE unit cost = BuildCalculator.io (converted to USD).
2) Apply EstimationPro.ai regional multiplier to that base for the job ZIP/state.
3) Your total (typical) should be near the TYPICAL of the LOW–HIGH range above.
4) Scope lock: price ONLY the described task.
5) Whole-home paint: unit="SF", suggestedQty = home floor sqft; unitPrice = typical total ÷ suggestedQty.
6) laborBreakdown.hours = TOTAL crew-hours (usually 25–90 for a 1,000–1,500 SF home paint job — never thousands).
7) MATERIALS = Lowe's mid-grade shelf. LABOR = hours × rate ($50–$85/hr typical).
8) total MUST equal unitPrice × suggestedQty.

${formatLowesPriceGuideForPrompt()}

TYPICAL INSTALLED TOTALS (Unit jobs = Lowe's materials + labor — adjust ±15–25% for the regional factors above):
- Screen/storm door handle or door knob/latch: $150–$400 | single outlet/switch/GFCI: $150–$450
- Faucet repair/cartridge: $150–$450 | new faucet install: $220–$550 | toilet replace: $350–$750
- Garbage disposal: $300–$650 | ceiling fan: $220–$550 | light fixture swap: $160–$450
- Interior prehung door: $280–$650 | entry door: $900–$2,800 | single window: $550–$1,600
- Drywall small patch: $175–$500 | water heater (tank): $1,200–$2,800
- Dishwasher install: $250–$550 | vanity install: $450–$1,400

${formatIndustryLaborPrompt()}

PRICING METHODOLOGY:
- Material unitPrice MUST match Lowe's.com mid-grade (Good/Better aisle), NOT Home Depot Pro, NOT specialty showroom, NOT installed package prices.
- Do NOT add contractor material markup into materials[] — materials are pure retail shelf cost; profit is only in the labor rate if at all.
- Do NOT add overhead, profit pad, contingency, or permits into unitPrice — direct Lowe's materials + direct labor only.
- laborBreakdown.hours = TOTAL crew-hours for the entire scope described.
- Do not under-quote large area work (roof, whole-house paint, full flooring).

MATERIALS LIST (client-facing — must match the quoted scope):
- Include ONLY materials directly required to complete the described work. No extras, no "just in case" items.
- QUANTITY MATH IS CRITICAL (full job counts — NEVER per-sqft fractions of a sheet):
  * 4×8 drywall/plywood/OSB sheet = 32 sqft. Sheets needed = ceil((job_sqft × 1.10) / 32).
    Example: 200 sqft ceiling drywall → ceil(200×1.10/32) = 7 sheets (qty: 7, unit: "sheet") — NOT 0.35, NOT 200.
  * Paint: ~350–400 sqft per gallon per coat → gallons = ceil(job_sqft × coats / 375).
  * Shingles: ~3 bundles per square (100 sqft) → bundles = ceil((sqft/100) × 3 × 1.10).
  * Flooring sold per sqft: qty ≈ job_sqft × 1.10 (include waste).
- materials[].qty must be the FULL JOB count the crew buys at Lowe's (whole sheets/bags/gallons).
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

    // Fix coverage math (drywall sheets, paint gallons, etc.) using job sqft
    const qtyCtx = {
      jobDescription,
      suggestedQty,
      unit: lineUnit,
    };
    materials = ensureCoverageMaterials(materials, qtyCtx, 14.98 * regional.materialMultiplier);
    materials = correctMaterialQuantities(materials, qtyCtx);

    // Contractor markup on materials purchased for the job (cost → sell)
    materials = applyMaterialMarkup(materials, DEFAULT_MATERIAL_MARKUP);

    // Labor: trust SuperGrok-style model hours when they look real; only force-engine if missing/absurd
    const rawLabor = parsed.laborBreakdown || parsed.labor || null;
    const modelHours = num(rawLabor?.hours, 0);
    const modelRate = num(rawLabor?.rate, 0);
    const modelLaborTotal = num(rawLabor?.total, 0);
    const paintJob = /paint|painting/i.test(jobDescription);
    const modelHoursLookReal =
      modelHours >= 4 &&
      modelHours <= (paintJob ? 120 : 400) &&
      !(paintJob && modelHours > 100 && suggestedQty <= 2000);

    let laborBreakdown: LaborBreakdown | null;
    if (modelHoursLookReal) {
      let hours = modelHours;
      let rate =
        modelRate >= 45 && modelRate <= 120
          ? modelRate
          : preferredLaborRate && preferredLaborRate >= 10
            ? preferredLaborRate
            : 62 * regional.laborMultiplier;
      if (preferredLaborRate && preferredLaborRate >= 10) rate = preferredLaborRate;
      let total =
        modelLaborTotal > 0 && modelLaborTotal < hours * rate * 2.5
          ? modelLaborTotal
          : roundMoney(hours * rate);
      // Per-SF billing: labor.total is share of one unit if needed by UI — keep full-job hours
      laborBreakdown = {
        description: String(rawLabor?.description || 'Labor').trim() || 'Labor',
        hours: roundMoney(hours),
        rate: roundMoney(rate),
        total: roundMoney(
          suggestedQty > 1 && /sf|sqft/i.test(lineUnit)
            ? total / Math.max(1, suggestedQty)
            : total
        ),
      };
    } else {
      laborBreakdown = normalizeLaborBreakdown(
        {
          description: String(rawLabor?.description || 'Labor').trim() || 'Labor',
          hours: modelHours,
          rate: modelRate,
          total: modelLaborTotal,
        },
        jobDescription,
        suggestedQty,
        regional.laborMultiplier,
        lineUnit,
        preferredLaborRate
      );
    }

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
      regional,
      preferredLaborRate
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
      // built is full-job $ — convert to per-unit when qty is SF/area
      if (built > 0) {
        memoryUnitPrice =
          suggestedQty > 1 ? roundMoney(built / suggestedQty) : built;
      }
    }
    memoryUnitPrice = coercePerUnitPrice(memoryUnitPrice, suggestedQty, {
      description: jobDescription,
    });

    const materialsCostTotal = sumMaterialTotals(materials);
    const laborCostTotal = roundMoney(laborBreakdown?.total || 0);
    const structured = resolveQuoteLineStructure(jobDescription, regional, {
      suggestedQty,
      unit: lineUnit || parsed.unit,
      unitPrice: memoryUnitPrice,
      total: roundMoney(memoryUnitPrice * Math.max(1, suggestedQty)),
    });

    if (structured.unitPrice <= 0 || structured.total <= 0) {
      return NextResponse.json({ error: 'AI could not produce a valid price for this description' }, { status: 500 });
    }

    // Hard clamp: never allow absurd per-SF paint (e.g. $2,971 × 1,200 SF)
    structured.unitPrice = coercePerUnitPrice(
      structured.unitPrice,
      structured.suggestedQty,
      {
        marketUnitPrice: structured.unitPrice,
        description: jobDescription,
      }
    );
    structured.total = roundMoney(structured.unitPrice * structured.suggestedQty);

    let aligned = buildAlignedQuoteBreakdown(
      materials,
      laborBreakdown,
      jobDescription,
      structured.unitPrice,
      structured.suggestedQty,
      structured.unit,
      regional,
      preferredLaborRate
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
        // Never assign full-job $ as unitPrice when suggestedQty is area SF
        const perUnit =
          structured.suggestedQty > 1
            ? roundMoney(built / structured.suggestedQty)
            : built;
        structured.unitPrice = coercePerUnitPrice(perUnit, structured.suggestedQty, {
          marketUnitPrice: structured.unitPrice,
          description: jobDescription,
        });
        structured.total = roundMoney(structured.unitPrice * structured.suggestedQty);
      }
    }

    // Last step: re-assert real sheet/bag counts + force contractor-preferred labor rate
    {
      const fixed = correctMaterialQuantities(aligned.materials as MaterialLine[], {
        jobDescription,
        suggestedQty: structured.suggestedQty,
        unit: structured.unit,
      });
      let lab = aligned.labor;
      if (lab && preferredLaborRate && preferredLaborRate >= 10) {
        const hours = Math.max(0.25, Number(lab.hours) || 0);
        lab = {
          ...lab,
          rate: preferredLaborRate,
          total: roundMoney(hours * preferredLaborRate),
        };
      }
      const matSum = sumMaterialTotals(fixed);
      const labSum = roundMoney(lab?.total || 0);
      aligned = {
        ...aligned,
        materials: fixed,
        materialsCostTotal: matSum,
        labor: lab,
        laborCostTotal: labSum,
      };
      // Keep unit price coherent: for SF lines, unitPrice is per SF of materials+labor
      const isSf =
        structured.suggestedQty > 1 &&
        /sf|sqft|sq\.?\s*ft|square/i.test(String(structured.unit || ''));
      if (isSf) {
        const laborFull =
          lab && lab.hours > 0 && lab.rate > 0
            ? roundMoney(lab.hours * lab.rate)
            : labSum;
        const jobTotal = roundMoney(matSum + laborFull);
        structured.total = jobTotal;
        structured.unitPrice = roundMoney(jobTotal / structured.suggestedQty);
        if (lab) {
          aligned.labor = { ...lab, total: laborFull };
          aligned.laborCostTotal = laborFull;
        }
      } else {
        const jobTotal = roundMoney(matSum + labSum);
        if (jobTotal > 0) {
          structured.unitPrice = jobTotal;
          structured.total = roundMoney(jobTotal * Math.max(1, structured.suggestedQty));
        }
      }
    }

    // Authority: BuildCalculator base × EstimationPro multiplier (typical), show low–high range
    {
      const modelTotal = num(parsed.total, 0);
      const qty = Math.max(
        1,
        priceRange?.quantity ||
          structured.suggestedQty ||
          parseSqftFromDescription(jobDescription) ||
          1
      );
      const isPaint = /paint|painting/i.test(jobDescription);

      if (priceRange && priceRange.typical > 0) {
        // Prefer BC×EP typical; soft-blend model only if inside the published range
        let finalTotal = priceRange.typical;
        if (
          modelTotal >= priceRange.low * 0.9 &&
          modelTotal <= priceRange.high * 1.1
        ) {
          finalTotal = roundMoney(priceRange.typical * 0.7 + modelTotal * 0.3);
        }
        // Clamp into range
        finalTotal = Math.min(priceRange.high, Math.max(priceRange.low, finalTotal));
        structured.suggestedQty = qty;
        // QuoteLineStructure.unit is only "SF" | "Unit" (priceRange.unit is a free string)
        structured.unit = /unit|ea|each|job|lot/i.test(String(priceRange.unit || ''))
          ? 'Unit'
          : 'SF';
        structured.billingMode = structured.unit === 'SF' ? 'sqft' : 'unit';
        structured.total = roundMoney(finalTotal);
        structured.unitPrice = roundMoney(finalTotal / qty);
      } else if (modelTotal > 50 && modelTotal < 50000 && qty <= 20) {
        if (Math.abs(modelTotal - structured.total) / modelTotal > 0.35) {
          structured.total = roundMoney(modelTotal);
          structured.unitPrice = roundMoney(modelTotal / Math.max(1, qty));
        }
      }

      // Labor hours: BC hours × soft EP labor mult, then model if sane
      if (aligned.labor) {
        let hrs = Number(aligned.labor.hours) || 0;
        const laborMult = epMultiplier?.laborMultiplier || epMult || 1;
        if (bcAnchor?.suggestedLaborHours && bcAnchor.suggestedLaborHours > 0) {
          const bcH = roundMoney(bcAnchor.suggestedLaborHours * laborMult);
          if (!modelHoursLookReal || Math.abs(hrs - bcH) / Math.max(bcH, 1) > 0.4) {
            hrs = bcH;
          } else {
            hrs = roundMoney(hrs * 0.4 + bcH * 0.6);
          }
        } else if (modelHoursLookReal) {
          hrs = laborBreakdown?.hours || hrs;
        }
        if (isPaint) hrs = Math.min(120, Math.max(8, hrs));
        const rate =
          preferredLaborRate && preferredLaborRate >= 10
            ? preferredLaborRate
            : Math.max(50, Number(aligned.labor.rate) || 62);
        const fullLabor = roundMoney(hrs * rate);
        aligned.labor = {
          ...aligned.labor,
          hours: roundMoney(hrs),
          rate: roundMoney(rate),
          total:
            structured.suggestedQty > 1 && /sf|sqft/i.test(String(structured.unit || ''))
              ? roundMoney(fullLabor / structured.suggestedQty)
              : fullLabor,
        };
        aligned.laborCostTotal = fullLabor;
      }
    }

    const industryMeta = estimateIndustryLabor(
      jobDescription,
      structured.suggestedQty,
      structured.unit
    );

    return NextResponse.json({
      unitPrice: structured.unitPrice,
      unit: structured.unit,
      suggestedQty: structured.suggestedQty,
      total: structured.total,
      billingMode: structured.billingMode,
      breakdown: parsed.breakdown,
      confidence: parsed.confidence,
      pricingMethod: priceRange
        ? 'buildcalculator+estimationpro'
        : bcAnchor
          ? 'supergrok+buildcalculator'
          : 'supergrok',
      quoteModel,
      /** Primary customer-facing bid = typical; always include low–high when available */
      priceRange: priceRange
        ? {
            low: priceRange.low,
            typical: priceRange.typical,
            high: priceRange.high,
            perSf: priceRange.perSf,
            unit: priceRange.unit,
            quantity: priceRange.quantity,
            label: priceRange.label,
            sources: priceRange.sources,
          }
        : null,
      estimationPro: epMultiplier
        ? {
            location: epMultiplier.label || epMultiplier.location,
            multiplier: epMult,
            laborMultiplier: epMultiplier.laborMultiplier,
            region: epMultiplier.region,
            source: 'https://estimationpro.ai/api',
          }
        : null,
      buildCalculator: bcAnchor
        ? {
            query: bcAnchor.query,
            baseUnitCostUsd: bcAnchor.baseUnitCostUsd,
            billingQuantity: bcAnchor.billingQuantity,
            suggestedJobTotalUsd: priceRange?.typical ?? bcAnchor.suggestedJobTotalUsd,
            suggestedPerSfUsd: priceRange?.perSf?.typical ?? bcAnchor.suggestedPerSfUsd,
            suggestedLaborHours: bcAnchor.suggestedLaborHours,
            bestMatch: bcAnchor.best
              ? {
                  name: bcAnchor.best.originalName,
                  totalPerSfUsd: bcAnchor.best.totalPerSfUsd,
                  section: bcAnchor.best.section,
                }
              : null,
            source: 'https://buildcalculator.io/api-docs/',
          }
        : null,
      materials: aligned.materials,
      materialsCostTotal: aligned.materialsCostTotal,
      laborCostTotal: aligned.laborCostTotal,
      laborBreakdown: aligned.labor,
      analyzedScope: imageAnalysis?.scopeDescription,
      imageAnalysis,
      industryLabor: industryMeta
        ? {
            trade: industryMeta.tradeLabel,
            tradeId: industryMeta.tradeId,
            measure: industryMeta.measure,
            quantity: industryMeta.quantity,
            expectedHours: industryMeta.expectedHours,
            phases: industryMeta.phases,
            notes: industryMeta.notes,
          }
        : null,
      priceMemoryApplied: {
        materials: finalMem.appliedMaterialCount,
        laborRate: finalMem.appliedLaborRate,
      },
      materialMarkup: DEFAULT_MATERIAL_MARKUP,
      materialMarkupPercent: Math.round((DEFAULT_MATERIAL_MARKUP - 1) * 100),
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