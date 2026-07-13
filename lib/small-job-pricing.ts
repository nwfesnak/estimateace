import type { RegionalPricing } from './ai-quote-region';
import type { PricingAnchorQuote } from './ai-quote-anchor';
import { BILLING_UNIT } from './quote-units';

const roundMoney = (n: number) => Math.round(n * 100) / 100;

export type SmallRepairCategory =
  | 'door_hardware'
  | 'plumbing_minor'
  | 'electrical_minor'
  | 'general_small';

type SmallRepairGuide = {
  label: string;
  minTotal: number;
  maxTotal: number;
  typicalHours: number;
  materialsTypical: number;
  materialsLabel: string;
};

const SMALL_REPAIR_GUIDES: Record<SmallRepairCategory, SmallRepairGuide> = {
  door_hardware: {
    label: 'door hardware repair',
    minTotal: 150,
    maxTotal: 450,
    typicalHours: 1.5,
    materialsTypical: 75,
    materialsLabel: 'Door / screen door handle or hardware kit',
  },
  plumbing_minor: {
    label: 'minor plumbing repair',
    minTotal: 165,
    maxTotal: 550,
    typicalHours: 2,
    materialsTypical: 85,
    materialsLabel: 'Plumbing parts & supplies',
  },
  electrical_minor: {
    label: 'minor electrical repair',
    minTotal: 175,
    maxTotal: 500,
    typicalHours: 1.75,
    materialsTypical: 45,
    materialsLabel: 'Electrical device & supplies',
  },
  general_small: {
    label: 'small repair',
    minTotal: 125,
    maxTotal: 400,
    typicalHours: 1.25,
    materialsTypical: 55,
    materialsLabel: 'Materials & supplies',
  },
};

const LARGE_SCOPE_BLOCKERS =
  /whole[\s-]?(?:home|house)|entire\s+(?:home|house|interior|exterior)|\b\d{3,}\s*(?:sq\.?\s*ft|sqft|sf)\b|full\s+(?:roof|re[\s-]?roof)|new\s+(?:roof|door|window|kitchen|bath)|(?:install|replace)\s+(?:new\s+)?(?:entry|exterior|interior|prehung)\s+door|prehung\s+door|tear[\s-]?off|re[\s-]?roof/i;

const DOOR_HARDWARE_PATTERNS =
  /screen\s*door|storm\s*door|patio\s*door\s*handle|door\s*(?:handle|knob|latch|lever|lockset|deadbolt|hinge|closer)|handle\s*(?:on|for)\s*(?:the\s*)?(?:screen|storm|entry|front|back)\s*door|replac(?:e|ing)\s+(?:a\s+)?(?:broken\s+)?(?:screen\s+)?door\s*(?:handle|knob|hardware)/i;

const PLUMBING_MINOR_PATTERNS =
  /faucet\s*(?:cartridge|aerator|handle|repair|fix)|toilet\s*(?:flapper|fill\s*valve|handle|repair)|drain\s*stopper|leak(?:ing)?\s*(?:faucet|tap|under\s*sink)|replac(?:e|ing)\s+(?:a\s+)?(?:faucet\s*)?(?:cartridge|aerator)/i;

const ELECTRICAL_MINOR_PATTERNS =
  /(?:outlet|receptacle|switch|dimmer|gfci|gfi)\s*(?:replac|repair|install|fix)|replac(?:e|ing)\s+(?:an?\s+)?(?:outlet|receptacle|switch|dimmer|gfci)/i;

const GENERAL_SMALL_PATTERNS =
  /weather[\s-]?strip(?:ping)?|caulk(?:ing)?\s+(?:repair|around)|patch(?:ing)?\s+(?:small|minor)|replac(?:e|ing)\s+(?:a\s+)?(?:mailbox|house\s*number|doorbell)/i;

const REPAIR_INTENT =
  /repair|replac|fix|install|mount|adjust|re[\s-]?hang|tighten|broken|damaged|missing|worn/i;

/** True when the scope is a single small fixture/hardware repair — not a room-scale job. */
export function detectSmallRepairCategory(description: string): SmallRepairCategory | null {
  const text = description.trim();
  if (!text || text.length < 8) return null;
  if (LARGE_SCOPE_BLOCKERS.test(text)) return null;
  if (!REPAIR_INTENT.test(text)) return null;

  if (DOOR_HARDWARE_PATTERNS.test(text)) {
    if (!/full\s+door|new\s+door|prehung|entry\s+door\s+install/i.test(text)) {
      return 'door_hardware';
    }
  }
  if (PLUMBING_MINOR_PATTERNS.test(text)) return 'plumbing_minor';
  if (ELECTRICAL_MINOR_PATTERNS.test(text)) return 'electrical_minor';
  if (GENERAL_SMALL_PATTERNS.test(text)) return 'general_small';

  return null;
}

function regionalLaborRate(regional: RegionalPricing, category: SmallRepairCategory): number {
  const base =
    category === 'electrical_minor' ? 78 : category === 'plumbing_minor' ? 80 : 62;
  return roundMoney(base * regional.laborMultiplier);
}

function clampTotal(total: number, guide: SmallRepairGuide, regional: RegionalPricing): number {
  const regionalFloor = roundMoney(guide.minTotal * (0.92 + regional.laborMultiplier * 0.06));
  const regionalCeiling = roundMoney(guide.maxTotal * (0.95 + regional.laborMultiplier * 0.08));
  return roundMoney(Math.min(regionalCeiling, Math.max(regionalFloor, total)));
}

/** Deterministic lump-sum quote for small fixture/hardware repairs. */
export function buildSmallRepairAnchorQuote(
  description: string,
  regional: RegionalPricing
): PricingAnchorQuote | null {
  const category = detectSmallRepairCategory(description);
  if (!category) return null;

  const guide = SMALL_REPAIR_GUIDES[category];
  const laborRate = regionalLaborRate(regional, category);
  const materialsRetail = roundMoney(guide.materialsTypical * regional.materialMultiplier);
  const laborAtGuide = roundMoney(guide.typicalHours * laborRate);
  const rawTotal = roundMoney(materialsRetail + laborAtGuide);
  const total = clampTotal(rawTotal, guide, regional);

  let materialsShare = roundMoney(Math.min(materialsRetail, total * 0.42));
  let laborShare = roundMoney(total - materialsShare);
  if (laborShare < roundMoney(guide.typicalHours * 45)) {
    laborShare = roundMoney(Math.max(guide.typicalHours * 45, total - materialsShare));
    materialsShare = roundMoney(total - laborShare);
  }

  const materials = [
    {
      description: guide.materialsLabel,
      qty: 1,
      unit: 'ea',
      unitPrice: materialsShare,
      total: materialsShare,
    },
  ];

  const laborHours =
    laborRate > 0
      ? roundMoney(Math.max(0.5, Math.min(guide.typicalHours * 2, laborShare / laborRate)))
      : guide.typicalHours;
  const laborBreakdown = {
    description: `Labor — ${guide.label}`,
    hours: laborHours,
    rate: laborRate,
    total: laborShare,
  };

  return {
    jobType: `small_repair_${category}`,
    suggestedQty: 1,
    unit: BILLING_UNIT,
    unitPrice: total,
    total,
    confidence: 'high',
    breakdown: `Small ${guide.label}: materials ~$${materialsShare.toFixed(0)} + ${guide.typicalHours} hr labor @ $${laborRate.toFixed(0)}/hr. Lump-sum $${total.toFixed(2)} (typical market range $${guide.minTotal}–$${guide.maxTotal}).`,
    materials,
    laborBreakdown,
    materialsCostTotal: materialsShare,
    laborCostTotal: laborShare,
  };
}

/** Cap AI lump-sum output when it clearly overshoots a small repair scope. */
export function capSmallRepairUnitPrice(
  description: string,
  regional: RegionalPricing,
  unitPrice: number,
  total: number
): { unitPrice: number; total: number; capped: boolean } {
  const category = detectSmallRepairCategory(description);
  if (!category) return { unitPrice, total, capped: false };

  const guide = SMALL_REPAIR_GUIDES[category];
  const maxTotal = clampTotal(guide.maxTotal * 1.08, guide, regional);

  if (total <= maxTotal && unitPrice <= maxTotal) {
    return { unitPrice, total, capped: false };
  }

  const cappedTotal = maxTotal;
  return {
    unitPrice: cappedTotal,
    total: cappedTotal,
    capped: true,
  };
}

export function isSmallRepairScope(description: string): boolean {
  return detectSmallRepairCategory(description) !== null;
}