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

  let laborTotal = roundMoney(Math.max(0, jobTarget - materialsTotal));

  let hours = roundMoney(Number(labor?.hours) || expectedHours);
  if (hours <= 0) hours = expectedHours;

  // Prefer AI-provided rate when it looks sane; otherwise typical local rate
  let rate = roundMoney(Number(labor?.rate) || 0);
  if (rate < 35 || rate > maxRate * 1.15) rate = roundMoney(typicalRate);
  if (rate > maxRate) rate = maxRate;

  // If residual labor dollars are tiny/zero but we still have a job, rebuild labor from hours × rate
  const hoursDrivenLabor = roundMoney(hours * rate);
  if (laborTotal < minLaborShare * 0.5 && hoursDrivenLabor > 0 && jobTarget > 0) {
    laborTotal = roundMoney(Math.min(hoursDrivenLabor, jobTarget * 0.7));
    // Shrink materials so materials + labor still equals jobTarget
    const matsCap = roundMoney(Math.max(0, jobTarget - laborTotal));
    if (materialsTotal > matsCap && matsCap > 0 && materialsTotal > 0) {
      mats = scaleMaterialLines(mats, matsCap / materialsTotal);
      materialsTotal = sumMaterialTotals(mats);
    } else if (materialsTotal <= 0 && matsCap > 0) {
      mats = [
        recalcMaterialLine({
          description: 'Materials & supplies',
          qty: 1,
          unit: 'lot',
          unitPrice: matsCap,
          total: matsCap,
        }),
      ];
      materialsTotal = matsCap;
    }
    laborTotal = roundMoney(Math.max(0, jobTarget - materialsTotal));
  }

  if (hours > 0 && laborTotal > 0) {
    rate = roundMoney(laborTotal / hours);
    if (rate > maxRate) {
      rate = maxRate;
      hours = roundMoney(Math.max(0.5, laborTotal / rate));
    }
    if (rate < 35) {
      rate = roundMoney(Math.max(45, typicalRate));
      hours = roundMoney(Math.max(0.5, laborTotal / rate));
    }
    laborTotal = roundMoney(hours * rate);
  }

  let drift = roundMoney(jobTarget - (materialsTotal + laborTotal));
  if (Math.abs(drift) >= 0.01) {
    if (laborTotal > 0 || hours > 0) {
      laborTotal = roundMoney(Math.max(0, laborTotal + drift));
      if (hours > 0) rate = roundMoney(laborTotal / hours);
      if (laborTotal <= 0 && jobTarget > 0) {
        // Last resort: put remaining job $ into labor, never drop the labor row
        laborTotal = roundMoney(Math.max(jobTarget * 0.35, minLaborShare));
        hours = Math.max(0.5, hours || expectedHours);
        rate = roundMoney(laborTotal / hours);
        const matsCap = roundMoney(Math.max(0, jobTarget - laborTotal));
        if (materialsTotal > 0 && matsCap >= 0) {
          if (matsCap === 0) {
            mats = [];
            materialsTotal = 0;
          } else {
            mats = scaleMaterialLines(mats, matsCap / materialsTotal);
            materialsTotal = sumMaterialTotals(mats);
          }
        }
      }
      drift = roundMoney(jobTarget - (materialsTotal + laborTotal));
    }
    if (Math.abs(drift) >= 0.01 && materialsTotal > 0) {
      mats = scaleMaterialLines(mats, roundMoney((materialsTotal + drift) / materialsTotal));
      materialsTotal = sumMaterialTotals(mats);
    }
  }

  // Always emit a labor line when the job has a price (AI quote must include labor)
  const alignedLabor: BreakdownLabor | null =
    jobTarget > 0
      ? {
          description: String(labor?.description || 'Labor').trim() || 'Labor',
          hours: Math.max(0.25, hours || expectedHours),
          rate: Math.max(35, rate || typicalRate),
          total: Math.max(
            0.01,
            laborTotal > 0
              ? laborTotal
              : roundMoney(Math.max(0.25, hours || expectedHours) * Math.max(35, rate || typicalRate))
          ),
        }
      : laborTotal > 0
        ? {
            description: String(labor?.description || 'Labor').trim() || 'Labor',
            hours,
            rate,
            total: laborTotal,
          }
        : null;

  // If we forced labor total above residual, re-balance materials so sums match jobTarget
  if (alignedLabor && jobTarget > 0) {
    laborTotal = alignedLabor.total;
    const matsCap = roundMoney(Math.max(0, jobTarget - laborTotal));
    if (Math.abs(materialsTotal - matsCap) > 0.05 && materialsTotal > 0) {
      if (matsCap <= 0) {
        mats = [];
        materialsTotal = 0;
      } else {
        mats = scaleMaterialLines(mats, matsCap / materialsTotal);
        materialsTotal = sumMaterialTotals(mats);
      }
    }
    // Fix penny drift onto labor
    const sum = roundMoney(materialsTotal + laborTotal);
    const penny = roundMoney(jobTarget - sum);
    if (Math.abs(penny) >= 0.01) {
      laborTotal = roundMoney(laborTotal + penny);
      alignedLabor.total = laborTotal;
      if (alignedLabor.hours > 0) {
        alignedLabor.rate = roundMoney(laborTotal / alignedLabor.hours);
      }
    }
  }

  return {
    materials: mats,
    labor: alignedLabor,
    materialsCostTotal: materialsTotal,
    laborCostTotal: roundMoney(alignedLabor?.total || laborTotal),
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