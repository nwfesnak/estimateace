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

// Simple in-memory rate limiter (per-user, resets on server restart)
// For production: use Redis / Upstash / Vercel KV with proper middleware
const rateLimitMap = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT = 10; // requests
const WINDOW_MS = 60 * 1000; // 1 minute

const roundMoney = (n: number) => Math.round(n * 100) / 100;

type MaterialLine = {
  description: string;
  qty: number;
  unit: string;
  unitPrice: number;
  total: number;
};

const MISC_SUPPLY_PATTERNS =
  /fastener|screw|nail|bolt|anchor|staple|tape|adhesive|glue|caulk|sealant|primer|connector|fitting|coupling|strap|clip|bracket|wire nut|sandpaper|blade|bit|consumable|misc/i;

/** Mid-grade 2026 US big-box / supply-house material unit price ceilings (not luxury, not bulk commercial). */
const MATERIAL_UNIT_PRICE_CAPS: Array<{
  pattern: RegExp;
  unitPattern?: RegExp;
  maxUnitPrice: number;
  typicalUnitPrice: number;
}> = [
  { pattern: /drywall|sheetrock|gypsum/i, unitPattern: /sheet|ea/i, maxUnitPrice: 20, typicalUnitPrice: 14 },
  { pattern: /2x4|stud|lumber/i, unitPattern: /ea|piece|pc/i, maxUnitPrice: 7, typicalUnitPrice: 4.25 },
  { pattern: /plywood|osb|sheathing/i, unitPattern: /sheet|ea/i, maxUnitPrice: 55, typicalUnitPrice: 38 },
  { pattern: /laminate|lvp|vinyl plank|floating floor/i, unitPattern: /sqft|sq ft|sf/i, maxUnitPrice: 5.5, typicalUnitPrice: 2.75 },
  { pattern: /hardwood floor|engineered wood/i, unitPattern: /sqft|sq ft|sf/i, maxUnitPrice: 9, typicalUnitPrice: 5.5 },
  { pattern: /ceramic|porcelain|tile/i, unitPattern: /sqft|sq ft|sf/i, maxUnitPrice: 8, typicalUnitPrice: 4 },
  { pattern: /carpet/i, unitPattern: /sqft|sq ft|sf|sq yd|sy/i, maxUnitPrice: 6, typicalUnitPrice: 3.5 },
  { pattern: /interior paint|latex paint|wall paint/i, unitPattern: /gallon|gal/i, maxUnitPrice: 48, typicalUnitPrice: 32 },
  { pattern: /exterior paint/i, unitPattern: /gallon|gal/i, maxUnitPrice: 58, typicalUnitPrice: 38 },
  { pattern: /primer/i, unitPattern: /gallon|gal/i, maxUnitPrice: 35, typicalUnitPrice: 24 },
  { pattern: /shingle|roofing/i, unitPattern: /bundle|square|sq/i, maxUnitPrice: 42, typicalUnitPrice: 32 },
  { pattern: /asphalt|driveway seal/i, unitPattern: /gallon|gal/i, maxUnitPrice: 40, typicalUnitPrice: 28 },
  { pattern: /concrete mix|mortar|thinset|grout/i, unitPattern: /bag/i, maxUnitPrice: 18, typicalUnitPrice: 11 },
  { pattern: /insulation|fiberglass bat/i, unitPattern: /bag|roll|bundle/i, maxUnitPrice: 85, typicalUnitPrice: 55 },
  { pattern: /pvc|pex|copper pipe|pipe/i, unitPattern: /lf|ln ft|linear/i, maxUnitPrice: 12, typicalUnitPrice: 4.5 },
  { pattern: /wire|romex|cable/i, unitPattern: /lf|ft/i, maxUnitPrice: 3.5, typicalUnitPrice: 1.2 },
  { pattern: /outlet|receptacle|switch/i, unitPattern: /ea|each/i, maxUnitPrice: 8, typicalUnitPrice: 3.5 },
  { pattern: /toilet/i, unitPattern: /ea|each/i, maxUnitPrice: 350, typicalUnitPrice: 220 },
  { pattern: /faucet/i, unitPattern: /ea|each/i, maxUnitPrice: 220, typicalUnitPrice: 120 },
  { pattern: /vanity/i, unitPattern: /ea|each/i, maxUnitPrice: 650, typicalUnitPrice: 380 },
  { pattern: /water heater/i, unitPattern: /ea|each/i, maxUnitPrice: 1200, typicalUnitPrice: 750 },
  { pattern: /window/i, unitPattern: /ea|each/i, maxUnitPrice: 550, typicalUnitPrice: 320 },
  { pattern: /interior door|prehung/i, unitPattern: /ea|each/i, maxUnitPrice: 250, typicalUnitPrice: 145 },
  { pattern: /exterior door/i, unitPattern: /ea|each/i, maxUnitPrice: 650, typicalUnitPrice: 420 },
  { pattern: /fence|picket|panel/i, unitPattern: /ea|panel|section/i, maxUnitPrice: 95, typicalUnitPrice: 55 },
  { pattern: /deck board|composite deck/i, unitPattern: /lf|ea/i, maxUnitPrice: 18, typicalUnitPrice: 9 },
  { pattern: /siding/i, unitPattern: /sqft|sq ft|sf|piece/i, maxUnitPrice: 6, typicalUnitPrice: 3.25 },
  { pattern: /gutter/i, unitPattern: /lf|ft/i, maxUnitPrice: 14, typicalUnitPrice: 7 },
  { pattern: /mulch|topsoil/i, unitPattern: /cu yd|yard|bag/i, maxUnitPrice: 55, typicalUnitPrice: 32 },
];

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

  const qty = Math.max(1, scope.scopeQty);
  if (qty <= 4) {
    return finish(maxHoursPerUnit * 0.5, maxHoursPerUnit, maxHoursPerUnit * 2);
  }
  return finish(maxHoursPerUnit, maxHoursPerUnit * 2, maxHoursPerUnit * 4);
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

function recalcMaterialLine(m: MaterialLine): MaterialLine {
  const total = roundMoney(m.qty * m.unitPrice);
  return { ...m, total };
}

/** Pull inflated material unit prices toward mid-market retail ceilings. */
function calibrateMaterialPrices(materials: MaterialLine[], materialMultiplier = 1): MaterialLine[] {
  return materials.map(m => {
    const unit = m.unit.toLowerCase();
    const cap = MATERIAL_UNIT_PRICE_CAPS.find(
      entry =>
        entry.pattern.test(m.description) &&
        (!entry.unitPattern || entry.unitPattern.test(unit))
    );
    if (!cap) return m;

    const maxCap = roundMoney(cap.maxUnitPrice * materialMultiplier);
    const typicalCap = roundMoney(cap.typicalUnitPrice * materialMultiplier);

    if (m.unitPrice > maxCap) {
      const adjustedUnitPrice = roundMoney(
        m.unitPrice > maxCap * 1.5 ? typicalCap : maxCap
      );
      return recalcMaterialLine({ ...m, unitPrice: adjustedUnitPrice });
    }
    return m;
  });
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
  if (!labor) return null;

  const guide = estimateJobLaborHours(jobDescription, suggestedQty, unit);
  return buildLaborFromGuide(labor, guide, jobDescription, suggestedQty, laborMultiplier);
}

/** Final price = materials + realistic labor (hours × rate). Never crush price to a low AI guess. */
function finalizeLaborAndPrice(
  materials: MaterialLine[],
  labor: LaborBreakdown | null,
  jobDescription: string,
  suggestedQty: number,
  unit: string,
  laborMultiplier = 1,
  aiUnitPrice?: number
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
  if (hours < guide.minHours) hours = guide.expectedHours;
  if (hours > guide.maxHours) hours = guide.maxHours;

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
  let unitPrice = roundMoney(sumMaterialTotals(mats) + perUnitLabor);

  // Only scale UP when built-up is far below AI (materials likely missing) — never scale down.
  if (aiUnitPrice && unitPrice > 0 && unitPrice < aiUnitPrice * 0.75 && aiUnitPrice / unitPrice <= 1.6) {
    const ratio = aiUnitPrice / unitPrice;
    mats = mats.map(m => {
      const total = roundMoney(m.total * ratio);
      const unitPriceLine = m.qty > 0 ? roundMoney(total / m.qty) : total;
      return recalcMaterialLine({ ...m, unitPrice: unitPriceLine, total });
    });
    lab = {
      ...lab,
      total: roundMoney(lab.total * ratio),
    };
    unitPrice = roundMoney(sumMaterialTotals(mats) + lab.total);
  }

  return { materials: mats, labor: lab, unitPrice };
}

function sumMaterialTotals(materials: MaterialLine[]) {
  return roundMoney(materials.reduce((sum, m) => sum + m.total, 0));
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

    const apiKey = process.env.GROK_API_KEY;
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
    const regional = resolveRegionalPricing(jobLocation, companyLocation);

    const anchoredQuote = computePricingAnchor(jobDescription, regional);
    if (anchoredQuote) {
      const structured = resolveQuoteLineStructure(jobDescription, regional, {
        suggestedQty: anchoredQuote.suggestedQty,
        unit: anchoredQuote.unit,
        unitPrice: anchoredQuote.unitPrice,
        total: anchoredQuote.total,
      });
      return NextResponse.json({
        unitPrice: structured.unitPrice,
        unit: structured.unit,
        suggestedQty: structured.suggestedQty,
        total: structured.total,
        billingMode: structured.billingMode,
        breakdown: anchoredQuote.breakdown,
        confidence: anchoredQuote.confidence,
        materials: anchoredQuote.materials,
        materialsCostTotal: anchoredQuote.materialsCostTotal,
        laborCostTotal: anchoredQuote.laborCostTotal,
        laborBreakdown: anchoredQuote.laborBreakdown,
        pricingMethod: 'deterministic',
        analyzedScope: imageAnalysis?.scopeDescription,
        imageAnalysis,
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
        model: 'grok-3',
        messages: [
          {
            role: 'system',
            content: `You are a professional contractor cost estimator for residential and light commercial work.
Build competitive, market-aligned prices for the job's LOCAL area — NOT premium, NOT padded, NOT commercial/union rates.

PRICING ONLY — do not rewrite or improve the customer-facing line description. Price the scope exactly as described.

Return ONLY valid JSON for the described line item.

${regionalPrompt}

PRICING METHODOLOGY (critical):
- Use mid-grade 2026 retail / supply-house material costs for the job location (local Home Depot, Lowe's, regional supply house averages).
- Do NOT use luxury brands, specialty imports, or contractor resale markup on materials.
- Do NOT add overhead, profit margin, contingency, or permit fees into unitPrice — only direct materials + direct labor.
- Labor rates must reflect the LOCAL market described above — adjust hours and hourly rate for regional cost tier.
- laborBreakdown.hours = TOTAL crew-hours for the ENTIRE job scope (all sqft, squares, or units in the description) — never hours per sqft.
- Labor production guides (total job hours): roof replacement ~1.5–3.5 hrs per square (100 sqft); 4800 sqft roof ≈ 48 squares ≈ 72–170 hrs. Flooring ~1 hr per 25–35 sqft. Interior paint on a whole home: use PAINTABLE wall+ceiling sqft (~3–4× home floor sqft for a ranch), NOT floor sqft alone — e.g. 1500 sq ft ranch with 9 ft ceilings ≈ 5200 paintable sq ft ≈ 30–40 crew-hours. Small fixture swap 1–3 hrs.
- Do NOT return 4 hours for a large roof, whole-house paint, or other large-area work.
- The final unitPrice must cover realistic materials PLUS labor at production-based hours × local labor rate. Do not under-quote large jobs.

MATERIAL PRICE ANCHORS (per unit, mid-grade retail — scale up/down for the job region vs US average):
- Drywall sheet 4x8: $12–16 | 2x4x8 stud: $3.50–5 | Interior paint gallon: $28–38
- LVP/laminate flooring: $1.75–3.50/sqft | Ceramic tile: $2.50–5/sqft | Hardwood: $4–7/sqft
- Concrete mix bag 80lb: $6–12 | Thinset/grout bag: $8–15 | Shingles/bundle: $28–38
- PVC/PEX pipe: $0.60–4/lf | Outlet/switch: $1.50–4 ea | Interior door prehung: $120–180
- Faucet: $90–160 | Toilet: $180–280 | Vanity (single): $250–450

MATERIALS LIST (client-facing — must match the quoted scope):
- Include ONLY materials directly required to complete the described work. No extras, no "just in case" items.
- Quantities must fit the actual job size in the description. Do not over-order or assume maximum/worst-case scope.
- Do NOT list every fastener, tape, primer, connector, or consumable separately. Group minor items into one line when needed (e.g. "Misc. fasteners & supplies").
- Do NOT add separate waste-factor or contingency line items; bake normal waste (about 5–10%) into quantities quietly.
- Typical line items: 3–6 materials. Simple jobs: 2–4. Complex jobs: up to 8 maximum.
- Each material line needs: description (specific name/size), qty, unit, unitPrice, total.
- Skip materials that are negligible cost or not meaningful to show the client.

PRICING MATH (strict — numbers must reconcile):
- BILLING MODE (critical): If the job can be measured in square feet (paint, roof, flooring, drywall, siding, stucco, insulation), set suggestedQty = total sqft, unit = "SF", unitPrice = high-end local $/sqft. All other jobs (fixtures, fences, permits, lump-sum): suggestedQty = 1, unit = "Unit", unitPrice = full job total.
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

    const aiTargetUnitPrice =
      typeof parsed.unitPrice === 'number' && parsed.unitPrice > 0
        ? parsed.unitPrice
        : undefined;

    const rawMaterials = Array.isArray(parsed.materials)
      ? parsed.materials
      : parsed.materialBreakdown
        ? [parsed.materialBreakdown]
        : [];

    const parsedMaterials: MaterialLine[] = rawMaterials
      .filter((m: { description?: string }) => m?.description?.trim())
      .map((m: { description?: string; qty?: number; unit?: string; unitPrice?: number; total?: number }) => {
        const qty = typeof m.qty === 'number' ? m.qty : 1;
        const unitPrice = typeof m.unitPrice === 'number' ? m.unitPrice : 0;
        const total = typeof m.total === 'number' ? m.total : qty * unitPrice;
        return {
          description: String(m.description).trim(),
          qty,
          unit: m.unit ? String(m.unit).trim() : 'ea',
          unitPrice,
          total,
        };
      });

    const suggestedQty =
      typeof parsed.suggestedQty === 'number' && parsed.suggestedQty > 0
        ? parsed.suggestedQty
        : 1;

    let materials = trimRedundantConsumables(consolidateSmallConsumables(parsedMaterials));
    materials = calibrateMaterialPrices(materials, regional.materialMultiplier);

    const lineUnit = parsed.unit ? String(parsed.unit).trim() : '';

    let laborBreakdown = normalizeLaborBreakdown(
      parsed.laborBreakdown
        ? {
            description: String(parsed.laborBreakdown.description || 'Labor').trim(),
            hours: typeof parsed.laborBreakdown.hours === 'number' ? parsed.laborBreakdown.hours : 0,
            rate: typeof parsed.laborBreakdown.rate === 'number' ? parsed.laborBreakdown.rate : 0,
            total:
              typeof parsed.laborBreakdown.total === 'number'
                ? parsed.laborBreakdown.total
                : (parsed.laborBreakdown.hours || 0) * (parsed.laborBreakdown.rate || 0),
          }
        : null,
      jobDescription,
      suggestedQty,
      regional.laborMultiplier,
      lineUnit
    );

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
      aiTargetUnitPrice
    );
    materials = finalized.materials;
    laborBreakdown = finalized.labor;

    const materialsCostTotal = sumMaterialTotals(materials);
    const laborCostTotal = roundMoney(laborBreakdown?.total || 0);
    const structured = resolveQuoteLineStructure(jobDescription, regional, {
      suggestedQty,
      unit: lineUnit || parsed.unit,
      unitPrice: finalized.unitPrice,
      total: roundMoney(finalized.unitPrice * suggestedQty),
    });

    if (structured.unitPrice <= 0 || structured.total <= 0) {
      return NextResponse.json({ error: 'AI could not produce a valid price for this description' }, { status: 500 });
    }

    return NextResponse.json({
      unitPrice: structured.unitPrice,
      unit: structured.unit,
      suggestedQty: structured.suggestedQty,
      total: structured.total,
      billingMode: structured.billingMode,
      breakdown: parsed.breakdown,
      confidence: parsed.confidence,
      materials,
      materialsCostTotal,
      laborCostTotal,
      laborBreakdown,
      analyzedScope: imageAnalysis?.scopeDescription,
      imageAnalysis,
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