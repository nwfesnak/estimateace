import {
  applyLowesMaterialPrices,
  findLowesPriceGuide,
  LOWES_MATERIAL_PRICE_GUIDE,
} from './lowes-material-prices';

export type MarketMaterialLine = {
  description: string;
  qty: number;
  unit: string;
  unitPrice: number;
  total: number;
};

const roundMoney = (n: number) => Math.round(n * 100) / 100;

/**
 * Caps derived from Lowe's mid-grade shelf guide (kept for callers that
 * still reference MATERIAL_UNIT_PRICE_CAPS).
 */
export const MATERIAL_UNIT_PRICE_CAPS: Array<{
  pattern: RegExp;
  unitPattern?: RegExp;
  maxUnitPrice: number;
  typicalUnitPrice: number;
}> = LOWES_MATERIAL_PRICE_GUIDE.map((g) => ({
  pattern: g.pattern,
  unitPattern: g.unitPattern,
  maxUnitPrice: g.max,
  typicalUnitPrice: g.typical,
}));

export function recalcMaterialLine<T extends MarketMaterialLine>(m: T): T {
  const total = roundMoney((Number(m.qty) || 0) * (Number(m.unitPrice) || 0));
  return { ...m, total };
}

/**
 * Calibrate material unit prices to Lowe's.com mid-grade shelf levels.
 * Recognized products snap toward Lowe's typical; unknowns only get a light clamp.
 */
export function calibrateMaterialPrices(
  materials: MarketMaterialLine[],
  materialMultiplier = 1
): MarketMaterialLine[] {
  // Primary path: Lowe's shelf pricing
  const lowesPriced = applyLowesMaterialPrices(materials, materialMultiplier);

  // Secondary safety: any remaining outliers without a guide match
  return lowesPriced.map((m) => {
    if (m.unitPrice <= 0 && m.total > 0 && m.qty > 0) {
      return recalcMaterialLine({ ...m, unitPrice: roundMoney(m.total / m.qty) });
    }
    // Extreme AI hallucinations with no catalog match
    if (m.unitPrice > 8000) {
      return recalcMaterialLine({ ...m, unitPrice: roundMoney(m.unitPrice * 0.35) });
    }
    return recalcMaterialLine(m);
  });
}

export function sumMaterialTotals(materials: MarketMaterialLine[]): number {
  return roundMoney(materials.reduce((sum, m) => sum + (Number(m.total) || 0), 0));
}

export { findLowesPriceGuide, applyLowesMaterialPrices };