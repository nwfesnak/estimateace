import {
  calibrateMaterialPrices,
  recalcMaterialLine,
  sumMaterialTotals,
  type MarketMaterialLine,
} from './market-material-caps';
import {
  detectWholeHomeInteriorPaint,
  estimateInteriorPaintableSqft,
  parseSqftFromDescription,
} from './quote-units';

const roundMoney = (n: number) => Math.round(n * 100) / 100;

export type BreakdownLabor = {
  description: string;
  hours: number;
  rate: number;
  total: number;
};

type AlignOptions = {
  jobDescription: string;
  suggestedQty: number;
  unit?: string;
  lineTotal?: number;
  materialMultiplier?: number;
  typicalLaborRate?: number;
  maxLaborRate?: number;
  expectedLaborHours?: number;
};

export function isPerSqftBilling(unit?: string, qty?: number): boolean {
  const normalized = (unit || '').trim().toLowerCase();
  const lineQty = qty ?? 1;
  return (
    lineQty > 1 &&
    ['sf', 'sqft', 'sq ft', 'sq. ft', 'square feet', 'square foot'].includes(normalized)
  );
}

export type JobBillingContext = {
  lineQty: number;
  unit: string;
  perSqft: boolean;
  unitPrice: number;
  jobTotal: number;
};

/** Infer SF billing from unit/qty/description when the line was saved incorrectly. */
export function resolveJobBillingContext(
  jobDescription: string,
  suggestedQty: number,
  unit?: string,
  unitPrice?: number,
  lineTotal?: number
): JobBillingContext {
  let unitTarget = roundMoney(Math.max(0, unitPrice || 0));
  let lineQty = Math.max(1, suggestedQty || 1);
  let billingUnit = (unit || '').trim();
  const descSqft = parseSqftFromDescription(jobDescription);

  if (!isPerSqftBilling(billingUnit, lineQty) && descSqft && descSqft >= 100 && unitTarget > 0 && unitTarget < 30) {
    lineQty = descSqft;
    if (!billingUnit || billingUnit.toLowerCase() === 'unit') billingUnit = 'SF';
  }

  let perSqft = isPerSqftBilling(billingUnit, lineQty);
  if (!perSqft && descSqft && descSqft >= 100 && unitTarget > 0 && unitTarget < 30) {
    lineQty = descSqft;
    billingUnit = 'SF';
    perSqft = true;
  }

  let jobTotal = perSqft ? roundMoney(unitTarget * lineQty) : unitTarget;
  if (lineTotal != null && lineTotal > 0) {
    jobTotal = roundMoney(lineTotal);
    if (perSqft && lineQty > 1) {
      unitTarget = roundMoney(jobTotal / lineQty);
    } else if (!perSqft && lineQty <= 1) {
      unitTarget = jobTotal;
    } else if (lineQty > 1) {
      unitTarget = roundMoney(jobTotal / lineQty);
    }
  }

  return {
    lineQty,
    unit: billingUnit || (perSqft ? 'SF' : 'Unit'),
    perSqft,
    unitPrice: unitTarget,
    jobTotal,
  };
}

/** Map a full-job built-up total to estimate line qty × unit price. */
export function syncLineItemPricingFromJobTotal(
  description: string,
  qty: number,
  unit: string,
  jobTotal: number
): { qty: number; unit: string; price: number; total: number } {
  const billing = resolveJobBillingContext(description, qty, unit, 0, jobTotal);
  const total = roundMoney(jobTotal);
  const price =
    billing.lineQty > 1 ? roundMoney(total / billing.lineQty) : total;

  return {
    qty: billing.lineQty,
    unit: billing.unit,
    price,
    total,
  };
}

function looksLikePerSqftBreakdown(
  materials: MarketMaterialLine[],
  labor: BreakdownLabor | null,
  jobTotal: number
): boolean {
  if (jobTotal < 100) return false;
  const matSum = sumMaterialTotals(materials);
  const labSum = roundMoney(labor?.total || 0);
  const builtUp = roundMoney(matSum + labSum);
  if (builtUp >= jobTotal * 0.2) return false;

  const paintLine = materials.find(m => /paint|latex|primer/i.test(m.description) && /gallon|gal/i.test(m.unit));
  if (paintLine && paintLine.unitPrice > 0 && paintLine.unitPrice < 10) return true;

  return builtUp < 50;
}

function scaleMaterialLines(materials: MarketMaterialLine[], ratio: number): MarketMaterialLine[] {
  return materials.map(m => {
    const total = roundMoney(m.total * ratio);
    const unitPrice = m.qty > 0 ? roundMoney(total / m.qty) : total;
    return recalcMaterialLine({ ...m, unitPrice, total });
  });
}

function scaleMaterialsToJobScale(materials: MarketMaterialLine[], lineQty: number): MarketMaterialLine[] {
  return materials.map(m =>
    recalcMaterialLine({
      ...m,
      total: roundMoney(m.total * lineQty),
      unitPrice: m.qty > 0 ? roundMoney((m.total * lineQty) / m.qty) : roundMoney(m.total * lineQty),
    })
  );
}

/** Realistic paint + supplies for a whole-home interior paint job. */
export function buildWholeHomePaintMaterials(
  description: string,
  jobTarget: number,
  materialMultiplier = 1
): MarketMaterialLine[] | null {
  const scope = detectWholeHomeInteriorPaint(description);
  if (!scope) return null;

  const paintableSqft = estimateInteriorPaintableSqft(scope.floorSqft, scope.ceilingFt);
  const gallons = Math.max(2, Math.ceil((paintableSqft * scope.coats) / 350));
  const gallonPrice = roundMoney(32 * materialMultiplier);
  const materialsBudget = roundMoney(jobTarget * 0.36);
  const paintBudget = roundMoney(Math.min(materialsBudget * 0.72, gallons * gallonPrice));
  const suppliesBudget = roundMoney(Math.max(0, materialsBudget - paintBudget));

  const lines: MarketMaterialLine[] = [];
  if (paintBudget > 0) {
    lines.push(
      recalcMaterialLine({
        description: `Interior latex paint (${scope.coats} coat${scope.coats > 1 ? 's' : ''})`,
        qty: gallons,
        unit: 'gallon',
        unitPrice: gallons > 0 ? roundMoney(paintBudget / gallons) : gallonPrice,
        total: paintBudget,
      })
    );
  }
  if (suppliesBudget > 0) {
    lines.push(
      recalcMaterialLine({
        description: 'Tape, rollers, brushes, drop cloths & supplies',
        qty: 1,
        unit: 'lot',
        unitPrice: suppliesBudget,
        total: suppliesBudget,
      })
    );
  }
  return lines.length ? lines : null;
}

/**
 * Align client-facing cost breakdown at FULL JOB scale (real retail qty × price).
 * For SF-billed lines, unitPrice is per SF but breakdown shows total job materials/labor.
 */
export function alignBreakdownToUnitPrice(
  materials: MarketMaterialLine[],
  labor: BreakdownLabor | null,
  targetUnitPrice: number,
  options: AlignOptions
): {
  materials: MarketMaterialLine[];
  labor: BreakdownLabor | null;
  materialsCostTotal: number;
  laborCostTotal: number;
} {
  const billing = resolveJobBillingContext(
    options.jobDescription,
    options.suggestedQty,
    options.unit,
    targetUnitPrice,
    options.lineTotal
  );
  const jobTarget =
    options.lineTotal != null && options.lineTotal > 0
      ? roundMoney(options.lineTotal)
      : billing.jobTotal;
  const lineQty = billing.lineQty;
  const perSqft = billing.perSqft;

  const materialMultiplier = options.materialMultiplier ?? 1;
  const typicalRate = options.typicalLaborRate ?? 58;
  const maxRate = options.maxLaborRate ?? 72;
  const expectedHours = Math.max(0.5, options.expectedLaborHours ?? labor?.hours ?? 2);

  let mats = calibrateMaterialPrices(
    materials.filter(m => m.description?.trim()).map(m => recalcMaterialLine(m)),
    materialMultiplier
  );

  let materialsTotal = sumMaterialTotals(mats);
  const corrupted = looksLikePerSqftBreakdown(mats, labor, jobTarget);

  if (corrupted || (perSqft && (materialsTotal <= 0 || materialsTotal < jobTarget * 0.08))) {
    const paintMaterials = buildWholeHomePaintMaterials(
      options.jobDescription,
      jobTarget,
      materialMultiplier
    );
    if (paintMaterials) {
      mats = paintMaterials;
      materialsTotal = sumMaterialTotals(mats);
    } else if (materialsTotal > 0 && lineQty > 1) {
      mats = scaleMaterialsToJobScale(mats, lineQty);
      materialsTotal = sumMaterialTotals(mats);
    }
  }

  const targetMaterialsShare = roundMoney(jobTarget * 0.36);
  const maxMaterialsShare = roundMoney(jobTarget * 0.48);

  if (materialsTotal <= 0) {
    const paintMaterials = buildWholeHomePaintMaterials(
      options.jobDescription,
      jobTarget,
      materialMultiplier
    );
    mats = paintMaterials || [
      {
        description: 'Materials & supplies',
        qty: 1,
        unit: 'lot',
        unitPrice: targetMaterialsShare,
        total: targetMaterialsShare,
      },
    ];
    materialsTotal = sumMaterialTotals(mats);
  } else if (materialsTotal > maxMaterialsShare && jobTarget > 200) {
    const ratio = targetMaterialsShare / materialsTotal;
    if (ratio >= 0.45) {
      mats = scaleMaterialLines(mats, ratio);
      materialsTotal = sumMaterialTotals(mats);
    } else {
      const paintMaterials = buildWholeHomePaintMaterials(
        options.jobDescription,
        jobTarget,
        materialMultiplier
      );
      if (paintMaterials) {
        mats = paintMaterials;
        materialsTotal = sumMaterialTotals(mats);
      }
    }
  } else if (materialsTotal < targetMaterialsShare * 0.55 && jobTarget > 200) {
    const ratio = targetMaterialsShare / Math.max(materialsTotal, 0.01);
    mats = scaleMaterialLines(mats, Math.min(ratio, 2.5));
    materialsTotal = sumMaterialTotals(mats);
  }

  let laborTotal = roundMoney(Math.max(0, jobTarget - materialsTotal));

  let hours = roundMoney(Number(labor?.hours) || expectedHours);
  if (hours <= 0) hours = expectedHours;

  let rate = roundMoney(typicalRate);
  if (hours > 0 && laborTotal > 0) {
    rate = roundMoney(laborTotal / hours);
    if (rate > maxRate) {
      rate = maxRate;
      hours = roundMoney(Math.max(0.5, laborTotal / rate));
    }
    if (rate < 45) {
      rate = roundMoney(Math.max(45, typicalRate));
      hours = roundMoney(Math.max(0.5, laborTotal / rate));
    }
    laborTotal = roundMoney(hours * rate);
  }

  let drift = roundMoney(jobTarget - (materialsTotal + laborTotal));
  if (Math.abs(drift) >= 0.01) {
    if (laborTotal > 0) {
      laborTotal = roundMoney(Math.max(0, laborTotal + drift));
      if (hours > 0) rate = roundMoney(laborTotal / hours);
      drift = roundMoney(jobTarget - (materialsTotal + laborTotal));
    }
    if (Math.abs(drift) >= 0.01 && materialsTotal > 0) {
      mats = scaleMaterialLines(mats, roundMoney((materialsTotal + drift) / materialsTotal));
      materialsTotal = sumMaterialTotals(mats);
    }
  }

  const alignedLabor: BreakdownLabor | null =
    laborTotal > 0
      ? {
          description: String(labor?.description || 'Labor').trim() || 'Labor',
          hours,
          rate,
          total: laborTotal,
        }
      : null;

  return {
    materials: mats,
    labor: alignedLabor,
    materialsCostTotal: materialsTotal,
    laborCostTotal: laborTotal,
  };
}

/** Fix stored line breakdown (e.g. legacy per-SF pennies) for display or save. */
export function normalizeStoredCostBreakdown(input: {
  description: string;
  qty: number;
  unit: string;
  unitPrice: number;
  total?: number;
  materials: MarketMaterialLine[];
  labor: BreakdownLabor | null;
  materialMultiplier?: number;
  typicalLaborRate?: number;
  maxLaborRate?: number;
  expectedLaborHours?: number;
}) {
  const billing = resolveJobBillingContext(
    input.description,
    input.qty,
    input.unit,
    input.unitPrice,
    input.total
  );

  const aligned = alignBreakdownToUnitPrice(input.materials, input.labor, billing.unitPrice, {
    jobDescription: input.description,
    suggestedQty: billing.lineQty,
    unit: billing.unit,
    lineTotal: billing.jobTotal,
    materialMultiplier: input.materialMultiplier,
    typicalLaborRate: input.typicalLaborRate,
    maxLaborRate: input.maxLaborRate,
    expectedLaborHours: input.expectedLaborHours ?? input.labor?.hours,
  });

  const jobTotal = roundMoney(aligned.materialsCostTotal + aligned.laborCostTotal);
  const linePricing = syncLineItemPricingFromJobTotal(
    input.description,
    billing.lineQty,
    billing.unit,
    jobTotal
  );

  return {
    billing: {
      ...billing,
      unitPrice: linePricing.price,
      jobTotal: linePricing.total,
    },
    linePricing,
    ...aligned,
  };
}