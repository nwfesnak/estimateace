export type MarketMaterialLine = {
  description: string;
  qty: number;
  unit: string;
  unitPrice: number;
  total: number;
};

const roundMoney = (n: number) => Math.round(n * 100) / 100;

/** Mid-grade 2026 US big-box / supply-house material unit price guides (retail, not luxury). */
export const MATERIAL_UNIT_PRICE_CAPS: Array<{
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
  { pattern: /door|screen door|storm door/i, unitPattern: /handle|knob|hardware|kit|ea/i, maxUnitPrice: 120, typicalUnitPrice: 65 },
  { pattern: /handle|knob|latch|lockset|deadbolt|hinge/i, unitPattern: /ea|each|kit/i, maxUnitPrice: 95, typicalUnitPrice: 48 },
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

export function recalcMaterialLine<T extends MarketMaterialLine>(m: T): T {
  const total = roundMoney(m.qty * m.unitPrice);
  return { ...m, total };
}

/** Pull inflated material unit prices toward mid-market retail. */
export function calibrateMaterialPrices(
  materials: MarketMaterialLine[],
  materialMultiplier = 1
): MarketMaterialLine[] {
  return materials.map(m => {
    const unit = m.unit.toLowerCase();
    const cap = MATERIAL_UNIT_PRICE_CAPS.find(
      entry => entry.pattern.test(m.description) && (!entry.unitPattern || entry.unitPattern.test(unit))
    );
    if (!cap) return recalcMaterialLine(m);

    const maxCap = roundMoney(cap.maxUnitPrice * materialMultiplier);
    const typicalCap = roundMoney(cap.typicalUnitPrice * materialMultiplier);

    if (m.unitPrice > maxCap) {
      const adjustedUnitPrice = roundMoney(m.unitPrice > maxCap * 1.5 ? typicalCap : maxCap);
      return recalcMaterialLine({ ...m, unitPrice: adjustedUnitPrice });
    }
    if (m.unitPrice <= 0 && m.total > 0 && m.qty > 0) {
      return recalcMaterialLine({ ...m, unitPrice: roundMoney(m.total / m.qty) });
    }
    return recalcMaterialLine(m);
  });
}

export function sumMaterialTotals(materials: MarketMaterialLine[]): number {
  return roundMoney(materials.reduce((sum, m) => sum + m.total, 0));
}