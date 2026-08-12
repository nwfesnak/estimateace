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

  /*
   * Always reserve labor on a real job. Materials alone can eat the full
   * unit price (especially after calibrate/scale), which used to drop labor to null.
   * Target ~35–55% labor share for typical install work; never wipe labor when hours exist.
   */
  const minLaborShare =
    jobTarget > 0
      ? roundMoney(Math.min(jobTarget * 0.55, Math.max(jobTarget * 0.28, 25)))
      : 0;
  const maxMaterialsForLabor = roundMoney(Math.max(0, jobTarget - minLaborShare));
  if (jobTarget > 0 && materialsTotal > maxMaterialsForLabor && maxMaterialsForLabor > 0) {
    mats = scaleMaterialLines(mats, maxMaterialsForLabor / materialsTotal);
    materialsTotal = sumMaterialTotals(mats);
  }

  /*
   * Prefer realistic HOURS from the labor guide over residual dollars from a
   * low unit price. Old bug: $242 job − materials left ~$68 labor → 1.67 hrs
   * even when the work (demo+hang+tape+paint 200 SF ceiling) needs ~15–20 hrs.
   */
  let hours = roundMoney(Number(labor?.hours) || expectedHours);
  if (hours <= 0) hours = expectedHours;
  // Never collapse long jobs below ~70% of expected crew-hours
  if (expectedHours >= 3 && hours < expectedHours * 0.7) {
    hours = roundMoney(expectedHours);
  }

  // Prefer AI-provided rate when it looks sane; otherwise typical local rate
  let rate = roundMoney(Number(labor?.rate) || 0);
  if (rate < 45 || rate > maxRate * 1.15) rate = roundMoney(typicalRate);
  if (rate > maxRate) rate = maxRate;
  if (rate < 45) rate = roundMoney(Math.max(55, typicalRate));

  // Labor dollars driven by real hours first (life-like), not leftover after materials
  let laborTotal = roundMoney(hours * rate);
  const hoursDrivenLabor = laborTotal;

  // If fixed jobTarget is way below materials + real labor, expand labor side of truth
  // by keeping hours and accepting a higher built-up (caller uses materials+labor).
  if (jobTarget > 0 && laborTotal + materialsTotal > jobTarget * 1.15) {
    // Keep realistic hours; do not crush hours to fit a too-low target
    laborTotal = hoursDrivenLabor;
  } else if (jobTarget > 0) {
    const residual = roundMoney(Math.max(0, jobTarget - materialsTotal));
    // Use the larger of residual and hours-driven labor (never shrink hours for a cheap residual)
    if (residual > laborTotal * 1.1 && residual > 0) {
      laborTotal = residual;
      if (hours > 0) rate = roundMoney(laborTotal / hours);
      if (rate > maxRate) {
        rate = maxRate;
        hours = roundMoney(Math.max(expectedHours * 0.7, laborTotal / rate));
        laborTotal = roundMoney(hours * rate);
      }
      if (rate < 45) {
        rate = roundMoney(Math.max(55, typicalRate));
        hours = Math.max(hours, roundMoney(laborTotal / rate));
        laborTotal = roundMoney(hours * rate);
      }
    }
  }

  // Materials should not erase labor room on realistic jobs
  if (materialsTotal > 0 && laborTotal > 0 && jobTarget > 0) {
    const maxMats = roundMoney(Math.max(0, (materialsTotal + laborTotal) * 0.55));
    if (materialsTotal > maxMats && maxMats > 0) {
      mats = scaleMaterialLines(mats, maxMats / materialsTotal);
      materialsTotal = sumMaterialTotals(mats);
    }
  }

  // Rebuild labor from final hours × rate (source of truth for life-like quotes)
  hours = Math.max(0.5, hours || expectedHours);
  rate = Math.max(45, Math.min(maxRate, rate || typicalRate));
  laborTotal = roundMoney(hours * rate);

  // True job cost = materials + realistic labor (may exceed a too-low AI unit target)
  const builtUpJob = roundMoney(materialsTotal + laborTotal);

  const alignedLabor: BreakdownLabor = {
    description: String(labor?.description || 'Labor').trim() || 'Labor',
    hours: roundMoney(hours),
    rate: roundMoney(rate),
    total: laborTotal,
  };

  // Only penny-fix to jobTarget when we're already close (within 12%) — never crush hours
  if (jobTarget > 0 && builtUpJob > 0) {
    const ratio = jobTarget / builtUpJob;
    if (ratio >= 0.88 && ratio <= 1.12) {
      const scaled = scaleBreakdownToJobTotal(mats, alignedLabor, jobTarget);
      return {
        materials: scaled.materials,
        labor: scaled.labor,
        materialsCostTotal: scaled.materialsCostTotal,
        laborCostTotal: scaled.laborCostTotal,
      };
    }
  }

  return {
    materials: mats,
    labor: alignedLabor,
    materialsCostTotal: materialsTotal,
    laborCostTotal: laborTotal,
  };
}

/**
 * Recalc material/labor dollar totals from qty × unitPrice and hours × rate.
 * Does NOT invent new rates — preserves user edits.
 */
export function recalcBreakdownAsStored(
  materials: MarketMaterialLine[],
  labor: BreakdownLabor | null
): {
  materials: MarketMaterialLine[];
  labor: BreakdownLabor | null;
  materialsCostTotal: number;
  laborCostTotal: number;
  builtUp: number;
} {
  const mats = (materials || [])
    .filter((m) => m?.description?.trim())
    .map((m) => {
      const qty = Number(m.qty) || 0;
      const unitPrice = roundMoney(Number(m.unitPrice) || 0);
      let total = roundMoney(Number(m.total) || 0);
      if (qty > 0 && unitPrice > 0) total = roundMoney(qty * unitPrice);
      else if (total > 0 && qty > 0 && unitPrice <= 0) {
        return recalcMaterialLine({
          ...m,
          qty,
          unitPrice: roundMoney(total / qty),
          total,
        });
      }
      return recalcMaterialLine({
        description: String(m.description || '').trim(),
        qty,
        unit: String(m.unit || '').trim() || 'ea',
        unitPrice,
        total,
      });
    });

  let lab: BreakdownLabor | null = null;
  if (labor && (labor.description || labor.hours || labor.rate || labor.total)) {
    const hours = Number(labor.hours) || 0;
    let rate = roundMoney(Number(labor.rate) || 0);
    let total = roundMoney(Number(labor.total) || 0);
    if (hours > 0 && rate > 0) total = roundMoney(hours * rate);
    else if (hours > 0 && total > 0 && rate <= 0) rate = roundMoney(total / hours);
    lab = {
      description: String(labor.description || 'Labor').trim() || 'Labor',
      hours,
      rate,
      total,
    };
  }

  const materialsCostTotal = sumMaterialTotals(mats);
  const laborCostTotal = roundMoney(lab?.total || 0);
  return {
    materials: mats,
    labor: lab,
    materialsCostTotal,
    laborCostTotal,
    builtUp: roundMoney(materialsCostTotal + laborCostTotal),
  };
}

/**
 * Scale money amounts so materials + labor = jobTotal.
 * Keeps material qty and labor hours; adjusts unit prices and rate.
 */
export function scaleBreakdownToJobTotal(
  materials: MarketMaterialLine[],
  labor: BreakdownLabor | null,
  jobTotal: number
): {
  materials: MarketMaterialLine[];
  labor: BreakdownLabor | null;
  materialsCostTotal: number;
  laborCostTotal: number;
  builtUp: number;
} {
  const target = roundMoney(Math.max(0, jobTotal));
  const base = recalcBreakdownAsStored(materials, labor);
  if (target <= 0) return base;

  const current = base.builtUp;
  if (current <= 0) {
    // No breakdown dollars yet — put everything in labor (or one materials lot)
    if (base.labor || !base.materials.length) {
      const hours = Math.max(0.5, base.labor?.hours || 2);
      const rate = roundMoney(target / hours);
      return {
        materials: base.materials,
        labor: {
          description: base.labor?.description || 'Labor',
          hours,
          rate,
          total: target,
        },
        materialsCostTotal: sumMaterialTotals(base.materials),
        laborCostTotal: target,
        builtUp: target,
      };
    }
    const mats = [
      recalcMaterialLine({
        description: base.materials[0]?.description || 'Materials & supplies',
        qty: 1,
        unit: 'lot',
        unitPrice: target,
        total: target,
      }),
    ];
    return {
      materials: mats,
      labor: null,
      materialsCostTotal: target,
      laborCostTotal: 0,
      builtUp: target,
    };
  }

  const ratio = target / current;
  const mats = scaleMaterialLines(base.materials, ratio);
  let lab = base.labor;
  if (lab) {
    const total = roundMoney((lab.total || 0) * ratio);
    const hours = Number(lab.hours) || 0;
    const rate = hours > 0 ? roundMoney(total / hours) : total;
    lab = { ...lab, total, rate };
  }

  // Fix penny drift on last material or labor
  let materialsCostTotal = sumMaterialTotals(mats);
  let laborCostTotal = roundMoney(lab?.total || 0);
  let drift = roundMoney(target - (materialsCostTotal + laborCostTotal));
  if (Math.abs(drift) >= 0.01) {
    if (lab && laborCostTotal > 0) {
      laborCostTotal = roundMoney(laborCostTotal + drift);
      const hours = Number(lab.hours) || 0;
      lab = {
        ...lab,
        total: laborCostTotal,
        rate: hours > 0 ? roundMoney(laborCostTotal / hours) : laborCostTotal,
      };
    } else if (mats.length) {
      const last = mats[mats.length - 1];
      const total = roundMoney(last.total + drift);
      mats[mats.length - 1] = recalcMaterialLine({
        ...last,
        total,
        unitPrice: last.qty > 0 ? roundMoney(total / last.qty) : total,
      });
      materialsCostTotal = sumMaterialTotals(mats);
    }
  }

  return {
    materials: mats,
    labor: lab,
    materialsCostTotal: sumMaterialTotals(mats),
    laborCostTotal: roundMoney(lab?.total || 0),
    builtUp: target,
  };
}

/**
 * When line qty changes, scale material qtys (and labor hours) by the same ratio,
 * keep unit prices/rates, then optionally nudge money to match line total.
 */
export function scaleBreakdownQuantities(
  materials: MarketMaterialLine[],
  labor: BreakdownLabor | null,
  qtyRatio: number,
  jobTotal?: number
): ReturnType<typeof scaleBreakdownToJobTotal> {
  const r = Number.isFinite(qtyRatio) && qtyRatio > 0 ? qtyRatio : 1;
  const mats = (materials || []).map((m) => {
    const qty = roundMoney((Number(m.qty) || 0) * r);
    const unitPrice = roundMoney(Number(m.unitPrice) || 0);
    return recalcMaterialLine({
      ...m,
      qty,
      unitPrice,
      total: roundMoney(qty * unitPrice),
    });
  });
  let lab = labor;
  if (labor) {
    const hours = roundMoney((Number(labor.hours) || 0) * r);
    const rate = roundMoney(Number(labor.rate) || 0);
    lab = {
      ...labor,
      hours,
      rate,
      total: roundMoney(hours * rate),
    };
  }
  const base = recalcBreakdownAsStored(mats, lab);
  if (jobTotal != null && jobTotal > 0 && Math.abs(base.builtUp - jobTotal) > 0.05) {
    return scaleBreakdownToJobTotal(mats, lab, jobTotal);
  }
  return base;
}

/** Fix stored line breakdown for display or save. */
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
  /** When true, keep user-edited unit prices / rates — only scale to line total if needed */
  preferStored?: boolean;
}) {
  const billing = resolveJobBillingContext(
    input.description,
    input.qty,
    input.unit,
    input.unitPrice,
    input.total
  );

  // User-edited breakdowns: preserve exact unit prices / labor rate
  if (input.preferStored) {
    const stored = recalcBreakdownAsStored(input.materials, input.labor);
    let materials = stored.materials;
    let labor = stored.labor;
    let materialsCostTotal = stored.materialsCostTotal;
    let laborCostTotal = stored.laborCostTotal;
    let jobTotal = stored.builtUp;

    // Soft match to line total if off by more than a few cents
    if (billing.jobTotal > 0 && Math.abs(jobTotal - billing.jobTotal) > 0.05) {
      const scaled = scaleBreakdownToJobTotal(materials, labor, billing.jobTotal);
      materials = scaled.materials;
      labor = scaled.labor;
      materialsCostTotal = scaled.materialsCostTotal;
      laborCostTotal = scaled.laborCostTotal;
      jobTotal = scaled.builtUp;
    }

    const linePricing = syncLineItemPricingFromJobTotal(
      input.description,
      billing.lineQty,
      billing.unit,
      billing.jobTotal > 0 ? billing.jobTotal : jobTotal
    );

    return {
      billing: {
        ...billing,
        unitPrice: linePricing.price,
        jobTotal: linePricing.total,
      },
      linePricing,
      materials,
      labor,
      materialsCostTotal,
      laborCostTotal,
    };
  }

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