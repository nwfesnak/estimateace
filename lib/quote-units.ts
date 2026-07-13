import type { RegionalPricing } from './ai-quote-region';
import { capSmallRepairUnitPrice, isSmallRepairScope } from './small-job-pricing';

const roundMoney = (n: number) => Math.round(n * 100) / 100;

export type WholeHomePaintScope = {
  floorSqft: number;
  ceilingFt: number;
  coats: number;
};

/** Home floor sqft in description — not the same as paintable wall/ceiling sqft. */
export function detectWholeHomeInteriorPaint(description: string): WholeHomePaintScope | null {
  const text = description.toLowerCase();
  if (!/paint|painting|primer|coat/i.test(text)) return null;
  if (
    !/(home|house|ranch|residence|interior|whole|entire|single[\s-]?story|1[\s-]?story|bungalow|craftsman|townhome|townhouse|condo|apartment|flat)/i.test(
      text
    )
  ) {
    return null;
  }

  const sqft = parseSqftFromDescription(description);
  if (!sqft || sqft < 400 || sqft > 20000) return null;

  let ceilingFt = 8;
  const ceilMatch = text.match(
    /(\d+(?:\.\d+)?)\s*(?:ft|foot|')\s*(?:ceil|ceiling)|ceil(?:ing)?\s*(?:height\s*)?(?:of\s*)?(\d+(?:\.\d+)?)\s*(?:ft|foot|')?/i
  );
  if (ceilMatch) {
    ceilingFt = Number(ceilMatch[1] || ceilMatch[2]) || 8;
  }
  ceilingFt = Math.max(7, Math.min(20, ceilingFt));

  let coats = 1;
  if (/three\s*coat|3\s*coat|third\s*coat/i.test(text)) coats = 3;
  else if (/two\s*coat|2\s*coat|second\s*coat/i.test(text)) coats = 2;

  return { floorSqft: sqft, ceilingFt, coats };
}

/** Estimate interior wall + ceiling paintable area from home floor sqft and ceiling height. */
export function estimateInteriorPaintableSqft(floorSqft: number, ceilingFt: number): number {
  const ceilingFactor = ceilingFt / 8;
  const wallFactor = 2.15 * ceilingFactor;
  return Math.round(floorSqft * (wallFactor + 1));
}

export const BILLING_SF = 'SF';
export const BILLING_UNIT = 'Unit';

/** Line-item unit suggestions in the estimate editor. */
export const LINE_ITEM_UNITS = [
  BILLING_SF,
  BILLING_UNIT,
  'sqft',
  'ea',
  'pieces',
  'lf',
  'ln ft',
  'sq yd',
  'cu yd',
  'gallons',
  'lbs',
  'tons',
  'bags',
  'rolls',
  'sheets',
  'boxes',
  'sets',
  'hours',
  'days',
  'lot',
  'job',
  'in',
  'ft',
] as const;

export type SqftJobType =
  | 'interior_paint_whole_home'
  | 'interior_paint'
  | 'exterior_paint'
  | 'roofing'
  | 'flooring_lvp'
  | 'flooring_tile'
  | 'flooring_hardwood'
  | 'flooring_carpet'
  | 'flooring_general'
  | 'drywall'
  | 'siding'
  | 'stucco'
  | 'insulation'
  | 'general_sqft';

/** Mid-market 2026 US installed contractor rates per sqft (national baseline). */
const MID_MARKET_SQFT_RATES: Record<SqftJobType, number> = {
  interior_paint_whole_home: 2.2,
  interior_paint: 1.3,
  exterior_paint: 1.95,
  roofing: 4.9,
  flooring_lvp: 3.1,
  flooring_tile: 4.75,
  flooring_hardwood: 6.25,
  flooring_carpet: 3.85,
  flooring_general: 2.95,
  drywall: 2.45,
  siding: 5.1,
  stucco: 7.5,
  insulation: 2.05,
  general_sqft: 3.1,
};

export type SqftBillingContext = {
  jobType: SqftJobType;
  sqft: number;
  ceilingFactor: number;
  coatFactor: number;
};

export type QuoteLineStructure = {
  suggestedQty: number;
  unit: typeof BILLING_SF | typeof BILLING_UNIT;
  unitPrice: number;
  total: number;
  billingMode: 'sqft' | 'unit';
  sqftJobType?: SqftJobType;
};

const UNIT_ALIASES: Record<string, string> = {
  sf: BILLING_SF,
  sqft: BILLING_SF,
  'sq ft': BILLING_SF,
  'sq. ft': BILLING_SF,
  'square feet': BILLING_SF,
  'square foot': BILLING_SF,
  unit: BILLING_UNIT,
  units: BILLING_UNIT,
  ea: BILLING_UNIT,
  each: BILLING_UNIT,
  job: BILLING_UNIT,
  lot: BILLING_UNIT,
  lump: BILLING_UNIT,
  'lump sum': BILLING_UNIT,
  ls: BILLING_UNIT,
  project: BILLING_UNIT,
};

export function getLineItemUnitOptions(currentUnit?: string): string[] {
  const trimmed = (currentUnit || '').trim();
  if (!trimmed) return [...LINE_ITEM_UNITS];
  const exists = LINE_ITEM_UNITS.some(u => u.toLowerCase() === trimmed.toLowerCase());
  return exists ? [...LINE_ITEM_UNITS] : [trimmed, ...LINE_ITEM_UNITS];
}

export function parseSqftFromDescription(description: string): number | null {
  const text = description.toLowerCase();
  const match =
    text.match(/(\d[\d,]*)\s*(?:sq\.?\s*ft|sqft|sf|square\s*feet|square\s*foot)\b/i) ||
    text.match(/(\d[\d,]*)\s*sq\s*fr\b/i) ||
    text.match(/(\d[\d,]*)sq\s*ft\b/i) ||
    text.match(/(\d[\d,]*)sqft\b/i);
  if (!match) return null;
  const sqft = Number(match[1].replace(/,/g, ''));
  return Number.isFinite(sqft) && sqft > 0 ? sqft : null;
}

function parseCeilingFactor(description: string): number {
  const text = description.toLowerCase();
  const match = text.match(
    /(\d+(?:\.\d+)?)\s*(?:ft|foot|')\s*(?:ceil|ceiling)|ceil(?:ing)?\s*(?:height\s*)?(?:of\s*)?(\d+(?:\.\d+)?)/i
  );
  const ceilingFt = match ? Number(match[1] || match[2]) || 8 : 8;
  return Math.max(0.9, Math.min(1.35, ceilingFt / 8));
}

function parseCoatFactor(description: string): number {
  const text = description.toLowerCase();
  if (/three\s*coat|3\s*coat|third\s*coat/i.test(text)) return 2.15;
  if (/two\s*coat|2\s*coat|second\s*coat/i.test(text)) return 1.58;
  return 1;
}

function regionalBlend(regional: RegionalPricing): number {
  return roundMoney(regional.materialMultiplier * 0.32 + regional.laborMultiplier * 0.68);
}

function isSqftUnit(rawUnit?: string): boolean {
  const lower = (rawUnit || '').trim().toLowerCase();
  return ['sf', 'sqft', 'sq ft', 'sq. ft', 'square feet', 'square foot', 'squares', 'square'].includes(lower);
}

/** Classify jobs that should be quoted per square foot (SF) vs lump-sum Unit. */
export function detectSqftBillingContext(
  description: string,
  suggestedQty = 1,
  rawUnit?: string
): SqftBillingContext | null {
  if (isSmallRepairScope(description)) return null;

  const text = description.toLowerCase();
  const wholeHome = detectWholeHomeInteriorPaint(description);
  if (wholeHome) {
    return {
      jobType: 'interior_paint_whole_home',
      sqft: wholeHome.floorSqft,
      ceilingFactor: wholeHome.ceilingFt / 8,
      coatFactor: wholeHome.coats === 1 ? 1 : wholeHome.coats === 2 ? 1.58 : 2.15,
    };
  }

  const sqftFromText = parseSqftFromDescription(description);
  const sqft =
    sqftFromText ||
    (isSqftUnit(rawUnit) && suggestedQty > 1 ? suggestedQty : null);

  if (!sqft || sqft < 50) return null;

  const ceilingFactor = parseCeilingFactor(description);
  const coatFactor = parseCoatFactor(description);

  if (/roof|shingle|re-?roof|tear[\s-]?off/i.test(text)) {
    return { jobType: 'roofing', sqft, ceilingFactor: 1, coatFactor: 1 };
  }
  if (/exterior\s*paint|outside\s*paint|paint\s*exterior/i.test(text)) {
    return { jobType: 'exterior_paint', sqft, ceilingFactor, coatFactor };
  }
  if (/paint|painting|primer|coat/i.test(text)) {
    return { jobType: 'interior_paint', sqft, ceilingFactor, coatFactor };
  }
  if (/hardwood|engineered\s*wood/i.test(text)) {
    return { jobType: 'flooring_hardwood', sqft, ceilingFactor: 1, coatFactor: 1 };
  }
  if (/tile|ceramic|porcelain/i.test(text)) {
    return { jobType: 'flooring_tile', sqft, ceilingFactor: 1, coatFactor: 1 };
  }
  if (/carpet/i.test(text)) {
    return { jobType: 'flooring_carpet', sqft, ceilingFactor: 1, coatFactor: 1 };
  }
  if (/laminate|lvp|vinyl\s*plank|floating\s*floor|floor/i.test(text)) {
    return { jobType: /laminate|lvp|vinyl/i.test(text) ? 'flooring_lvp' : 'flooring_general', sqft, ceilingFactor: 1, coatFactor: 1 };
  }
  if (/drywall|sheetrock|hang|mud|tape/i.test(text)) {
    return { jobType: 'drywall', sqft, ceilingFactor: 1, coatFactor: 1 };
  }
  if (/stucco/i.test(text)) {
    return { jobType: 'stucco', sqft, ceilingFactor: 1, coatFactor: 1 };
  }
  if (/siding/i.test(text)) {
    return { jobType: 'siding', sqft, ceilingFactor: 1, coatFactor: 1 };
  }
  if (/insulation|insulate/i.test(text)) {
    return { jobType: 'insulation', sqft, ceilingFactor: 1, coatFactor: 1 };
  }

  if (isSqftUnit(rawUnit) || sqftFromText) {
    return { jobType: 'general_sqft', sqft, ceilingFactor: 1, coatFactor: 1 };
  }

  return null;
}

export function getMarketSqftUnitPrice(
  context: SqftBillingContext,
  regional: RegionalPricing
): number {
  const base = MID_MARKET_SQFT_RATES[context.jobType];
  const adjusted =
    context.jobType === 'interior_paint_whole_home' || context.jobType === 'interior_paint'
      ? base * context.ceilingFactor * context.coatFactor
      : context.jobType === 'exterior_paint'
        ? base * context.coatFactor
        : base;
  return roundMoney(adjusted * regionalBlend(regional));
}

/** @deprecated Use getMarketSqftUnitPrice */
export const getHighEndSqftUnitPrice = getMarketSqftUnitPrice;

/**
 * Normalize AI quote output: sqft-capable jobs → qty = sqft, unit = SF, high-end $/sqft.
 * Everything else → qty = 1, unit = Unit, unitPrice = full job total.
 */
export function resolveQuoteLineStructure(
  description: string,
  regional: RegionalPricing,
  ai: {
    suggestedQty?: number;
    unit?: string;
    unitPrice?: number;
    total?: number;
  } = {}
): QuoteLineStructure {
  const sqftContext = detectSqftBillingContext(
    description,
    ai.suggestedQty,
    ai.unit
  );

  if (sqftContext) {
    const marketUnitPrice = getMarketSqftUnitPrice(sqftContext, regional);
    const aiUnitPrice = roundMoney(Number(ai.unitPrice) || 0);
    let unitPrice = marketUnitPrice;
    if (
      aiUnitPrice > 0 &&
      aiUnitPrice >= marketUnitPrice * 0.65 &&
      aiUnitPrice <= marketUnitPrice * 1.35
    ) {
      unitPrice = roundMoney(marketUnitPrice * 0.55 + aiUnitPrice * 0.45);
    }
    const suggestedQty = sqftContext.sqft;
    const total = roundMoney(unitPrice * suggestedQty);
    return {
      suggestedQty,
      unit: BILLING_SF,
      unitPrice,
      total,
      billingMode: 'sqft',
      sqftJobType: sqftContext.jobType,
    };
  }

  const aiQty = Math.max(1, Number(ai.suggestedQty) || 1);
  const aiUnitPrice = roundMoney(Number(ai.unitPrice) || 0);
  const aiTotal = roundMoney(
    Number(ai.total) > 0 ? Number(ai.total) : aiUnitPrice * aiQty
  );
  let total = roundMoney(Math.max(aiTotal, aiUnitPrice));
  let unitPrice = total;

  const capped = capSmallRepairUnitPrice(description, regional, unitPrice, total);
  unitPrice = capped.unitPrice;
  total = capped.total;

  return {
    suggestedQty: 1,
    unit: BILLING_UNIT,
    unitPrice,
    total,
    billingMode: 'unit',
  };
}

/** @deprecated Use resolveQuoteLineStructure */
export function resolveQuoteUnit(
  description: string,
  suggestedQty = 1,
  rawUnit?: string
): string {
  return resolveQuoteLineStructure(description, {
    label: '',
    city: '',
    state: '',
    zipCode: '',
    source: 'default',
    materialMultiplier: 1,
    laborMultiplier: 1,
    costTier: 'average',
  }, { suggestedQty, unit: rawUnit }).unit;
}