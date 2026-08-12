/**
 * Fix AI material quantities so they match real coverage math.
 *
 * Example: 200 sqft ceiling drywall → 4×8 sheets are 32 sqft each
 * → 200/32 = 6.25 → +10% waste → 7 sheets (NOT 0.35 sheets).
 *
 * Client-facing breakdowns always show full-job physical counts
 * (sheets, bags, gallons, ea) — never "per sqft" fractions of a sheet.
 */

import { parseSqftFromDescription } from './quote-units';
import { recalcMaterialLine, type MarketMaterialLine } from './market-material-caps';

const roundMoney = (n: number) => Math.round(n * 100) / 100;
const roundQty = (n: number, decimals = 2) =>
  Math.round(n * Math.pow(10, decimals)) / Math.pow(10, decimals);

export type QtyContext = {
  jobDescription: string;
  /** Line qty (often total SF for area jobs) */
  suggestedQty: number;
  unit?: string;
};

function jobSqft(ctx: QtyContext): number | null {
  const fromText = parseSqftFromDescription(ctx.jobDescription);
  if (fromText && fromText > 0) return fromText;
  const unit = (ctx.unit || '').toLowerCase();
  const q = Number(ctx.suggestedQty) || 0;
  if (q > 1 && /sf|sqft|sq\.?\s*ft|square/.test(unit)) return q;
  // Bare large qty with drywall/floor/paint wording → treat as sqft
  if (
    q >= 20 &&
    /drywall|sheetrock|paint|floor|roof|tile|siding|ceiling|wall/i.test(ctx.jobDescription)
  ) {
    return q;
  }
  return null;
}

function isSheetUnit(unit: string): boolean {
  return /sheet|ea|each|pc|piece|unit/i.test(unit || '') || !unit?.trim();
}

function ceilSheets(areaSqft: number, sheetSqft: number, waste = 0.1): number {
  if (areaSqft <= 0 || sheetSqft <= 0) return 1;
  return Math.max(1, Math.ceil((areaSqft * (1 + waste)) / sheetSqft));
}

/**
 * Correct material quantities using coverage rules for the job scope.
 * Preserves Lowe's unit prices; recalculates totals from qty × unitPrice.
 */
export function correctMaterialQuantities<T extends MarketMaterialLine>(
  materials: T[],
  ctx: QtyContext
): T[] {
  const sqft = jobSqft(ctx);
  const desc = ctx.jobDescription || '';

  return materials.map((m) => {
    const d = `${m.description || ''} ${desc}`;
    const unit = (m.unit || '').toLowerCase();
    let qty = Number(m.qty) || 0;
    let nextUnit = m.unit || 'ea';
    let changed = false;

    // --- Drywall / cement board sheets (4×8 = 32 sqft) ---
    if (/drywall|sheetrock|gypsum|cement\s*board|durock|hardiebacker|backer\s*board/i.test(d)) {
      if (sqft && sqft >= 10) {
        const sheetSqft = /2x2|2\s*x\s*2|ceiling\s*tile/i.test(d) ? 4 : 32;
        const need = ceilSheets(sqft, sheetSqft, 0.1);
        // Fix fractions / per-SF nonsense (e.g. 0.35, 0.03) or wild over-counts
        if (qty < 1 || qty < need * 0.5 || qty > need * 3 || !Number.isInteger(qty)) {
          qty = need;
          nextUnit = isSheetUnit(unit) ? unit || 'sheet' : 'sheet';
          if (!/sheet|ea|each/i.test(nextUnit)) nextUnit = 'sheet';
          changed = true;
        }
      } else if (qty > 0 && qty < 1) {
        // Fractional sheet with no sqft — at least 1
        qty = 1;
        nextUnit = 'sheet';
        changed = true;
      }
    }

    // --- Plywood / OSB 4×8 ---
    else if (/plywood|osb|sheathing/i.test(d) && isSheetUnit(unit)) {
      if (sqft && sqft >= 10) {
        const need = ceilSheets(sqft, 32, 0.1);
        if (qty < 1 || qty < need * 0.5 || qty > need * 3) {
          qty = need;
          nextUnit = 'sheet';
          changed = true;
        }
      }
    }

    // --- Paint gallons (~350–400 sqft/gal per coat) ---
    else if (/paint|primer|latex/i.test(d) && /gal|gallon/i.test(unit)) {
      if (sqft && sqft >= 20) {
        const coats = /primer/i.test(d) ? 1 : /two\s*coat|2\s*coat/i.test(desc) ? 2 : 1;
        const coverage = /primer/i.test(d) ? 300 : 375;
        const need = Math.max(1, Math.ceil((sqft * coats) / coverage));
        if (qty < 1 || qty < need * 0.5 || qty > need * 4) {
          qty = need;
          changed = true;
        }
      }
    }

    // --- Flooring sold per sqft (LVP, tile, laminate) ---
    else if (
      /lvp|vinyl\s*plank|laminate|hardwood|tile|carpet|flooring/i.test(d) &&
      /sqft|sq\s*ft|sf/i.test(unit)
    ) {
      if (sqft && sqft >= 20) {
        const need = roundQty(sqft * 1.1, 0); // 10% waste, whole sqft
        if (qty < sqft * 0.5 || qty > sqft * 2.5 || qty < 1) {
          qty = Math.max(1, need);
          changed = true;
        }
      }
    }

    // --- Shingles: ~3 bundles per square (100 sqft) ---
    else if (/shingle/i.test(d) && /bundle|bndl/i.test(unit)) {
      if (sqft && sqft >= 50) {
        const squares = sqft / 100;
        const need = Math.max(1, Math.ceil(squares * 3 * 1.1));
        if (qty < 1 || qty < need * 0.5 || qty > need * 3) {
          qty = need;
          changed = true;
        }
      }
    }

    // --- Studs: rough wall estimate if framing mentioned with sqft ---
    else if (/\b2\s*x\s*4\b|2x4|stud/i.test(d) && isSheetUnit(unit) && sqft && sqft >= 50) {
      // ~1 stud per 16" of wall; rough: floor_sqft walls ≈ sqrt(sqft)*4 perimeter / 1.33
      const perimeter = Math.sqrt(sqft) * 4;
      const need = Math.max(4, Math.ceil((perimeter / 1.33) * 1.1));
      if (qty < 1 || (qty < need * 0.35 && qty < 10)) {
        // Only fix clearly broken tiny counts
        if (qty < 1 || qty <= 2) {
          qty = need;
          changed = true;
        }
      }
    }

    // Generic: never leave fractional "each/sheet/bag" under 1
    if (
      !changed &&
      qty > 0 &&
      qty < 1 &&
      /sheet|ea|each|bag|bundle|roll|box|pc|piece|gallon|gal/i.test(unit)
    ) {
      qty = 1;
      changed = true;
    }

    if (!changed) {
      return recalcMaterialLine({ ...m, qty: qty || m.qty, unit: nextUnit }) as T;
    }

    return recalcMaterialLine({
      ...m,
      qty,
      unit: nextUnit,
      unitPrice: Number(m.unitPrice) || 0,
    }) as T;
  });
}

/**
 * Ensure drywall (and similar) always appear with a sane sheet count when
 * the job mentions area but AI omitted sheets or used wrong qty.
 */
export function ensureCoverageMaterials<T extends MarketMaterialLine>(
  materials: T[],
  ctx: QtyContext,
  defaultSheetPrice = 14.98
): T[] {
  const sqft = jobSqft(ctx);
  if (!sqft || sqft < 10) return materials;

  const desc = ctx.jobDescription || '';
  const hasDrywallWork = /drywall|sheetrock|gypsum|hang\s*rock|ceiling|taper/i.test(desc);
  const hasDrywallLine = materials.some((m) =>
    /drywall|sheetrock|gypsum|cement\s*board/i.test(m.description || '')
  );

  if (hasDrywallWork && !hasDrywallLine) {
    const sheets = ceilSheets(sqft, 32, 0.1);
    const line = recalcMaterialLine({
      description: '1/2 in. x 4 ft. x 8 ft. Drywall Sheet',
      qty: sheets,
      unit: 'sheet',
      unitPrice: defaultSheetPrice,
      total: 0,
    }) as T;
    return [line, ...materials];
  }

  return materials;
}
