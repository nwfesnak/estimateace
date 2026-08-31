/**
 * Fixed residential estimating math — gallons, hours, rates, reconcile.
 * Source of truth for template-priced quotes (not LLM invent).
 */
import type { RegionalPricing } from './ai-quote-region';
import { estimateInteriorPaintableSqft } from './quote-units';

export const roundMoney = (n: number) => Math.round(n * 100) / 100;
export const roundHours = (n: number) => Math.round(n * 10) / 10;

export type QuoteMaterial = {
  description: string;
  qty: number;
  unit: string;
  unitPrice: number;
  total: number;
};

export type QuoteLabor = {
  description: string;
  hours: number;
  rate: number;
  total: number;
};

export type LockedQuote = {
  templateId: string;
  suggestedQty: number;
  unit: 'SF' | 'LF' | 'Unit';
  unitPrice: number;
  total: number;
  billingMode: 'sqft' | 'lf' | 'unit';
  materials: QuoteMaterial[];
  laborBreakdown: QuoteLabor;
  materialsCostTotal: number;
  laborCostTotal: number;
  breakdown: string;
  confidence: 'high' | 'medium' | 'low';
  factsUsed: Record<string, number | string | boolean | null | undefined>;
};

export function materialLine(
  description: string,
  qty: number,
  unit: string,
  unitPrice: number
): QuoteMaterial {
  const q = Math.max(0, Number(qty) || 0);
  const p = roundMoney(Math.max(0, Number(unitPrice) || 0));
  return {
    description,
    qty: q,
    unit,
    unitPrice: p,
    total: roundMoney(q * p),
  };
}

export function paintableFromFloor(floorSqft: number, ceilingFt = 8): number {
  return estimateInteriorPaintableSqft(
    Math.max(1, floorSqft),
    Math.max(7, Math.min(20, ceilingFt || 8))
  );
}

/** Gallons = ceil(area × coats / coverage). */
export function gallonsForArea(
  areaSqft: number,
  coats: number,
  coveragePerGallon = 360
): number {
  const area = Math.max(0, areaSqft);
  const c = Math.max(1, Math.min(3, Math.round(coats) || 1));
  if (area <= 0) return 0;
  return Math.max(1, Math.ceil((area * c) / Math.max(200, coveragePerGallon)));
}

export function regionalLaborRate(
  regional: RegionalPricing,
  base = 62
): number {
  return roundMoney(base * (regional.laborMultiplier || 1));
}

export function regionalMaterialPrice(
  regional: RegionalPricing,
  base: number
): number {
  return roundMoney(base * (regional.materialMultiplier || 1));
}

export function regionalSfRate(
  regional: RegionalPricing,
  basePerSf: number,
  coatFactor = 1
): number {
  const blend =
    (regional.materialMultiplier || 1) * 0.32 + (regional.laborMultiplier || 1) * 0.68;
  return roundMoney(basePerSf * coatFactor * blend);
}

/** Same regional blend for per-linear-foot installed rates. */
export function regionalLfRate(
  regional: RegionalPricing,
  basePerLf: number
): number {
  return regionalSfRate(regional, basePerLf, 1);
}

/** Regionalized lump-sum (unit job) mid total. */
export function regionalUnitTotal(
  regional: RegionalPricing,
  nationalMid: number
): number {
  const blend =
    (regional.materialMultiplier || 1) * 0.38 + (regional.laborMultiplier || 1) * 0.62;
  return roundMoney(nationalMid * blend);
}

/**
 * Production crew-hours from area, then hard-cap.
 * Never returns fantasy thousands of hours for a residential paint job.
 */
export function crewHoursFromProduction(
  areaSqft: number,
  unitsPerHour: number,
  options?: { fixedHours?: number; minHours?: number; maxHours?: number }
): number {
  const area = Math.max(0, areaSqft);
  const uph = Math.max(1, unitsPerHour);
  let hours = (options?.fixedHours || 0) + (area > 0 ? area / uph : 0);
  const minH = options?.minHours ?? 1;
  const maxH = options?.maxHours ?? 90;
  hours = Math.max(minH, Math.min(maxH, hours));
  return roundHours(hours);
}

/**
 * HARD RULE: materials + labor === jobTotal (penny).
 * Labor hours are derived from labor $ / rate so hours×rate === labor total.
 * If production-max hours would be exceeded at the rate, we keep max hours and
 * raise the effective rate (still hours×rate === labor $) — never invent 2000 hrs.
 */
export function reconcileQuote(
  jobTotal: number,
  materialsIn: QuoteMaterial[],
  laborIn: Omit<QuoteLabor, 'total' | 'hours'> & { hours?: number; total?: number },
  options?: { maxHours?: number; minMaterialShare?: number; maxMaterialShare?: number }
): { materials: QuoteMaterial[]; labor: QuoteLabor; materialsCostTotal: number; laborCostTotal: number; total: number } {
  const total = roundMoney(Math.max(0, jobTotal));
  const maxHours = options?.maxHours ?? 120;
  const minMatShare = options?.minMaterialShare ?? 0.18;
  const maxMatShare = options?.maxMaterialShare ?? 0.42;

  let materials = materialsIn.map((m) =>
    materialLine(m.description, m.qty, m.unit, m.unitPrice)
  );
  let matSum = roundMoney(materials.reduce((s, m) => s + m.total, 0));

  // Keep materials in a sane share of job; scale unit prices if needed (keep qty physical)
  const minMat = roundMoney(total * minMatShare);
  const maxMat = roundMoney(total * maxMatShare);
  if (total > 50 && matSum > 0) {
    if (matSum > maxMat) {
      const scale = maxMat / matSum;
      materials = materials.map((m) =>
        materialLine(m.description, m.qty, m.unit, roundMoney(m.unitPrice * scale))
      );
      matSum = roundMoney(materials.reduce((s, m) => s + m.total, 0));
    } else if (matSum < minMat && matSum > 0) {
      const scale = minMat / matSum;
      materials = materials.map((m) =>
        materialLine(m.description, m.qty, m.unit, roundMoney(m.unitPrice * scale))
      );
      matSum = roundMoney(materials.reduce((s, m) => s + m.total, 0));
    }
  } else if (total > 50 && matSum <= 0) {
    matSum = minMat;
    materials = [
      materialLine('Materials & supplies', 1, 'lot', matSum),
    ];
  }

  // Penny fix materials vs target share
  if (matSum > total) {
    const scale = total / Math.max(matSum, 0.01);
    materials = materials.map((m) =>
      materialLine(m.description, m.qty, m.unit, roundMoney(m.unitPrice * scale))
    );
    matSum = roundMoney(materials.reduce((s, m) => s + m.total, 0));
  }

  let laborTotal = roundMoney(Math.max(0, total - matSum));
  // Absorb penny drift into last material if needed
  const drift = roundMoney(total - (matSum + laborTotal));
  if (Math.abs(drift) >= 0.01 && materials.length) {
    const last = materials[materials.length - 1];
    materials[materials.length - 1] = materialLine(
      last.description,
      last.qty,
      last.unit,
      last.qty > 0 ? roundMoney((last.total + drift) / last.qty) : roundMoney(last.total + drift)
    );
    matSum = roundMoney(materials.reduce((s, m) => s + m.total, 0));
    laborTotal = roundMoney(Math.max(0, total - matSum));
  }

  let rate = roundMoney(Math.max(45, Number(laborIn.rate) || 62));
  let hours = laborTotal > 0 ? roundHours(laborTotal / rate) : 0;

  if (hours > maxHours && laborTotal > 0) {
    hours = roundHours(maxHours);
    rate = roundMoney(laborTotal / hours);
  }
  if (hours < 0.5 && laborTotal >= 25) {
    hours = 0.5;
    rate = roundMoney(laborTotal / hours);
  }

  // Final identity: hours × rate must equal laborTotal (adjust rate for rounding)
  if (hours > 0) {
    rate = roundMoney(laborTotal / hours);
    // Recompute laborTotal from hours×rate and fix materials for penny
    const labExact = roundMoney(hours * rate);
    const matExact = roundMoney(total - labExact);
    if (materials.length && Math.abs(matExact - matSum) >= 0.01) {
      const last = materials[materials.length - 1];
      const delta = roundMoney(matExact - matSum);
      materials[materials.length - 1] = materialLine(
        last.description,
        last.qty,
        last.unit,
        last.qty > 0
          ? roundMoney((last.total + delta) / last.qty)
          : roundMoney(last.total + delta)
      );
      matSum = roundMoney(materials.reduce((s, m) => s + m.total, 0));
    }
    laborTotal = roundMoney(total - matSum);
    if (hours > 0) rate = roundMoney(laborTotal / hours);
  }

  const labor: QuoteLabor = {
    description: String(laborIn.description || 'Labor').trim() || 'Labor',
    hours: roundHours(hours),
    rate: roundMoney(rate),
    total: laborTotal,
  };

  return {
    materials,
    labor,
    materialsCostTotal: matSum,
    laborCostTotal: laborTotal,
    total,
  };
}

export function coatFactor(coats: number): number {
  const c = Math.max(1, Math.min(3, Math.round(coats) || 1));
  if (c === 1) return 1;
  if (c === 2) return 1.55;
  return 2.05;
}
