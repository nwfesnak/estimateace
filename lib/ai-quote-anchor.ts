import type { RegionalPricing } from './ai-quote-region';
import { buildSmallRepairAnchorQuote } from './small-job-pricing';
import {
  BILLING_SF,
  detectWholeHomeInteriorPaint,
  estimateInteriorPaintableSqft,
  getMarketSqftUnitPrice,
  type WholeHomePaintScope,
} from './quote-units';

const roundMoney = (n: number) => Math.round(n * 100) / 100;

export type AnchorMaterialLine = {
  description: string;
  qty: number;
  unit: string;
  unitPrice: number;
  total: number;
};

export type AnchorLaborBreakdown = {
  description: string;
  hours: number;
  rate: number;
  total: number;
};

export type PricingAnchorQuote = {
  jobType: string;
  suggestedQty: number;
  unit: string;
  unitPrice: number;
  total: number;
  breakdown: string;
  confidence: 'high' | 'medium';
  floorSqft?: number;
  paintableSqft?: number;
  materials: AnchorMaterialLine[];
  laborBreakdown: AnchorLaborBreakdown;
  materialsCostTotal: number;
  laborCostTotal: number;
};

export { detectWholeHomeInteriorPaint, estimateInteriorPaintableSqft };
export type { WholeHomePaintScope };

function recalcMaterialLine(m: AnchorMaterialLine): AnchorMaterialLine {
  const total = roundMoney(m.qty * m.unitPrice);
  return { ...m, total };
}

function paintLaborRates(regional: RegionalPricing) {
  const m = regional.laborMultiplier;
  return {
    typicalRate: roundMoney(62 * m),
    maxRate: roundMoney(75 * m),
  };
}

function buildWholeHomeInteriorPaintQuote(
  scope: WholeHomePaintScope,
  regional: RegionalPricing
): PricingAnchorQuote {
  const { floorSqft, ceilingFt, coats } = scope;
  const paintableSqft = estimateInteriorPaintableSqft(floorSqft, ceilingFt);
  const coatFactor = coats === 1 ? 1 : coats === 2 ? 1.58 : 2.15;

  const unitPrice = getMarketSqftUnitPrice(
    {
      jobType: 'interior_paint_whole_home',
      sqft: floorSqft,
      ceilingFactor: ceilingFt / 8,
      coatFactor,
    },
    regional
  );
  const total = roundMoney(unitPrice * floorSqft);

  const materialsJobTotal = roundMoney(total * 0.3);
  const laborJobTotal = roundMoney(total - materialsJobTotal);

  const coveragePerGallon = 350;
  const gallons = Math.max(2, Math.ceil((paintableSqft * coats) / coveragePerGallon));
  const gallonPrice = roundMoney(32 * regional.materialMultiplier);
  const paintTotal = roundMoney(Math.min(materialsJobTotal * 0.72, gallons * gallonPrice));
  const suppliesTotal = roundMoney(materialsJobTotal - paintTotal);

  const jobMaterials: AnchorMaterialLine[] = [
    recalcMaterialLine({
      description: `Interior latex paint (${coats} coat${coats > 1 ? 's' : ''})`,
      qty: gallons,
      unit: 'gallon',
      unitPrice: gallons > 0 ? roundMoney(paintTotal / gallons) : gallonPrice,
      total: paintTotal,
    }),
    recalcMaterialLine({
      description: 'Tape, rollers, brushes, drop cloths & supplies',
      qty: 1,
      unit: 'lot',
      unitPrice: suppliesTotal,
      total: suppliesTotal,
    }),
  ].filter(m => m.total > 0);

  const productionSqftPerHour = coats === 1 ? 145 : coats === 2 ? 95 : 70;
  // Cap hours: 1,200 SF home dual-coat interior is typically ~25–50 crew-hrs, not 2,000+
  const rawHours = Math.max(8, paintableSqft / productionSqftPerHour);
  const hours = roundMoney(Math.min(rawHours, Math.max(16, floorSqft / 18)));
  const { typicalRate } = paintLaborRates(regional);

  const laborBreakdown: AnchorLaborBreakdown = {
    description: `Interior painting labor (${paintableSqft.toLocaleString()} sq ft surfaces)`,
    hours,
    rate: typicalRate,
    // Prefer hours × rate when residual labor $ from SF total is unrealistic
    total: roundMoney(
      Math.min(laborJobTotal, Math.max(hours * typicalRate, laborJobTotal * 0.5))
    ),
  };

  return {
    jobType: 'whole_home_interior_paint',
    suggestedQty: floorSqft,
    unit: BILLING_SF,
    unitPrice,
    total,
    floorSqft,
    paintableSqft,
    confidence: 'high',
    breakdown: `Whole-home interior paint: ${floorSqft.toLocaleString()} sq ft home, ${ceilingFt} ft ceilings, ${coats} coat${coats > 1 ? 's' : ''}. ~${paintableSqft.toLocaleString()} sq ft walls + ceiling. ${floorSqft.toLocaleString()} SF × $${unitPrice.toFixed(2)}/SF (mid-market installed rate).`,
    materials: jobMaterials,
    laborBreakdown,
    materialsCostTotal: materialsJobTotal,
    laborCostTotal: laborJobTotal,
  };
}

export function computePricingAnchor(
  description: string,
  regional: RegionalPricing
): PricingAnchorQuote | null {
  const smallRepair = buildSmallRepairAnchorQuote(description, regional);
  if (smallRepair) return smallRepair;

  const wholeHome = detectWholeHomeInteriorPaint(description);
  if (wholeHome) {
    return buildWholeHomeInteriorPaintQuote(wholeHome, regional);
  }

  return null;
}