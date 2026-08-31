/**
 * Residential quote templates — fixed formulas set the price.
 * AI only classifies into a templateId + facts; this module prices.
 */
import type { RegionalPricing } from './ai-quote-region';
import { detectTaskMarketBand, regionalizeTaskBand } from './task-market-pricing';
import {
  coatFactor,
  crewHoursFromProduction,
  gallonsForArea,
  materialLine,
  paintableFromFloor,
  reconcileQuote,
  regionalLaborRate,
  regionalMaterialPrice,
  regionalSfRate,
  roundMoney,
  type LockedQuote,
  type QuoteMaterial,
} from './quote-formulas';
import { parseDimensionAreas } from './industry-labor-engine';
import {
  parsePrimaryFloorSqft,
  parseAllSqftFromDescription,
  detectWholeHomeInteriorPaint,
} from './quote-units';

export type QuoteFactKey =
  | 'floorSqft'
  | 'wallSqft'
  | 'roofSqft'
  | 'areaSqft'
  | 'coats'
  | 'ceilingFt'
  | 'quantity';

export type QuoteFacts = Partial<Record<QuoteFactKey, number>> & {
  notes?: string;
};

export type QuoteTemplateDef = {
  id: string;
  trade: string;
  label: string;
  requiredFacts: QuoteFactKey[];
  /** Human questions for the UI fact dialog */
  factQuestions: Partial<Record<QuoteFactKey, string>>;
  detect: RegExp;
  /** Higher = preferred when multiple match */
  priority: number;
  billing: 'sf' | 'unit';
};

export const QUOTE_TEMPLATES: QuoteTemplateDef[] = [
  {
    id: 'paint_interior_whole_home',
    trade: 'paint',
    label: 'Interior paint — whole home',
    requiredFacts: ['floorSqft', 'coats'],
    factQuestions: {
      floorSqft: 'Home floor square footage',
      coats: 'Number of paint coats (usually 2)',
      ceilingFt: 'Ceiling height (ft)',
    },
    detect:
      /paint|painting|primer|coat/i,
    priority: 100,
    billing: 'sf',
  },
  {
    id: 'paint_interior_walls',
    trade: 'paint',
    label: 'Interior paint — walls / room',
    requiredFacts: ['wallSqft', 'coats'],
    factQuestions: {
      wallSqft: 'Wall (or room) square footage to paint',
      coats: 'Number of paint coats',
    },
    detect: /paint|painting|primer|coat/i,
    priority: 70,
    billing: 'sf',
  },
  {
    id: 'paint_exterior',
    trade: 'paint',
    label: 'Exterior paint',
    requiredFacts: ['areaSqft', 'coats'],
    factQuestions: {
      areaSqft: 'Exterior surface square footage',
      coats: 'Number of coats',
    },
    detect: /exterior\s*paint|outside\s*paint|paint\s*exterior/i,
    priority: 90,
    billing: 'sf',
  },
  {
    id: 'texture_blend',
    trade: 'drywall',
    label: 'Wall texture repair / blend',
    requiredFacts: ['areaSqft'],
    factQuestions: {
      areaSqft: 'Area of texture repair (sq ft)',
    },
    detect: /texture|skim|blend\s*(?:wall|texture)|orange\s*peel|knockdown/i,
    priority: 75,
    billing: 'sf',
  },
  {
    id: 'drywall_area',
    trade: 'drywall',
    label: 'Drywall hang / finish (area)',
    requiredFacts: ['areaSqft'],
    factQuestions: { areaSqft: 'Drywall area (sq ft)' },
    detect: /drywall|sheetrock|hang\s*rock|tape\s*(?:and|&)?\s*mud/i,
    priority: 80,
    billing: 'sf',
  },
  {
    id: 'roofing',
    trade: 'roofing',
    label: 'Roofing',
    requiredFacts: ['roofSqft'],
    factQuestions: { roofSqft: 'Roof area (sq ft)' },
    detect: /roof|shingle|re-?roof|tear[\s-]?off/i,
    priority: 95,
    billing: 'sf',
  },
  {
    id: 'flooring_lvp',
    trade: 'flooring',
    label: 'Flooring — LVP / vinyl plank',
    requiredFacts: ['areaSqft'],
    factQuestions: { areaSqft: 'Floor area (sq ft)' },
    detect: /lvp|vinyl\s*plank|luxury\s*vinyl|rigid\s*core/i,
    priority: 85,
    billing: 'sf',
  },
  {
    id: 'flooring_tile',
    trade: 'flooring',
    label: 'Flooring — tile',
    requiredFacts: ['areaSqft'],
    factQuestions: { areaSqft: 'Floor area (sq ft)' },
    detect: /(?:floor|wall)\s*tile|ceramic|porcelain|tile\s*floor/i,
    priority: 85,
    billing: 'sf',
  },
  {
    id: 'flooring_hardwood',
    trade: 'flooring',
    label: 'Flooring — hardwood',
    requiredFacts: ['areaSqft'],
    factQuestions: { areaSqft: 'Floor area (sq ft)' },
    detect: /hardwood|engineered\s*wood/i,
    priority: 85,
    billing: 'sf',
  },
  {
    id: 'flooring_carpet',
    trade: 'flooring',
    label: 'Flooring — carpet',
    requiredFacts: ['areaSqft'],
    factQuestions: { areaSqft: 'Floor area (sq ft)' },
    detect: /carpet/i,
    priority: 80,
    billing: 'sf',
  },
  {
    id: 'flooring_general',
    trade: 'flooring',
    label: 'Flooring — general',
    requiredFacts: ['areaSqft'],
    factQuestions: { areaSqft: 'Floor area (sq ft)' },
    detect: /floor(?:ing)?|laminate/i,
    priority: 60,
    billing: 'sf',
  },
  {
    id: 'siding',
    trade: 'siding',
    label: 'Siding',
    requiredFacts: ['areaSqft'],
    factQuestions: { areaSqft: 'Siding area (sq ft)' },
    detect: /siding|hardie|cement\s*board\s*siding/i,
    priority: 88,
    billing: 'sf',
  },
  {
    id: 'insulation',
    trade: 'insulation',
    label: 'Insulation',
    requiredFacts: ['areaSqft'],
    factQuestions: { areaSqft: 'Insulation area (sq ft)' },
    detect: /insulat|batt|blown[\s-]?in|spray\s*foam/i,
    priority: 82,
    billing: 'sf',
  },
  {
    id: 'concrete',
    trade: 'concrete',
    label: 'Concrete / flatwork',
    requiredFacts: ['areaSqft'],
    factQuestions: { areaSqft: 'Concrete area (sq ft)' },
    detect: /concrete|flatwork|sidewalk|driveway|patio\s*slab/i,
    priority: 86,
    billing: 'sf',
  },
  {
    id: 'unit_task',
    trade: 'general',
    label: 'Unit / fixture job',
    requiredFacts: [],
    factQuestions: {},
    detect: /./,
    priority: 10,
    billing: 'unit',
  },
];

export function getTemplate(id: string): QuoteTemplateDef | undefined {
  return QUOTE_TEMPLATES.find((t) => t.id === id);
}

/** Deterministic template pick (no LLM). */
export function detectTemplateId(description: string): string {
  const text = String(description || '');
  const whole = detectWholeHomeInteriorPaint(text);
  if (whole) return 'paint_interior_whole_home';

  // Texture + whole-home paint language → whole home paint (texture is prep)
  if (
    /texture|blend/i.test(text) &&
    /paint|coat/i.test(text) &&
    (parsePrimaryFloorSqft(text) || 0) >= 400
  ) {
    return 'paint_interior_whole_home';
  }

  if (/exterior\s*paint|outside\s*paint|paint\s*(?:the\s*)?exterior/i.test(text)) {
    return 'paint_exterior';
  }

  const scored = QUOTE_TEMPLATES.filter((t) => t.id !== 'unit_task' && t.id !== 'paint_interior_whole_home')
    .filter((t) => t.detect.test(text))
    .sort((a, b) => b.priority - a.priority);

  if (scored[0]) {
    // Prefer wall paint when small SF only
    if (
      scored[0].id.startsWith('paint') &&
      !/whole|entire|home|house|bedroom|bath/i.test(text)
    ) {
      return 'paint_interior_walls';
    }
    if (scored[0].trade === 'paint' && (parsePrimaryFloorSqft(text) || 0) >= 400) {
      return 'paint_interior_whole_home';
    }
    // Texture-only without paint coats on whole home
    if (
      scored[0].id === 'texture_blend' &&
      /paint|two\s*coat|2\s*coat/i.test(text) &&
      (parsePrimaryFloorSqft(text) || 0) >= 400
    ) {
      return 'paint_interior_whole_home';
    }
    return scored[0].id;
  }

  const band = detectTaskMarketBand(text);
  if (band) return 'unit_task';
  return 'unit_task';
}

export function extractFactsFromDescription(
  description: string,
  templateId: string
): QuoteFacts {
  const text = String(description || '');
  const facts: QuoteFacts = {};
  const floor = parsePrimaryFloorSqft(text);
  const all = parseAllSqftFromDescription(text);
  const dims = parseDimensionAreas(text);
  const whole = detectWholeHomeInteriorPaint(text);

  if (whole) {
    facts.floorSqft = whole.floorSqft;
    facts.coats = whole.coats;
    facts.ceilingFt = whole.ceilingFt;
  }

  if (floor) facts.floorSqft = facts.floorSqft || floor;

  // Wall / room: prefer dimension product or smallest explicit SF under 400, else max dim
  if (dims.length) {
    const wallish = Math.max(...dims);
    facts.wallSqft = wallish;
    facts.areaSqft = facts.areaSqft || wallish;
  }
  const small = all.filter((n) => n > 0 && n < 400);
  if (small.length && !facts.wallSqft) facts.wallSqft = Math.max(...small);

  if (/roof|shingle/i.test(text) && floor) facts.roofSqft = floor;
  if (all.length && !facts.areaSqft) {
    facts.areaSqft =
      templateId === 'paint_interior_whole_home'
        ? facts.floorSqft
        : Math.max(...all);
  }

  if (/three\s*coat|3\s*coat/i.test(text)) facts.coats = 3;
  else if (/two\s*coat|2\s*coat|full\s*coats?|dual[\s-]*coat/i.test(text)) facts.coats = 2;
  else if (facts.coats == null && /paint|coat/i.test(text)) facts.coats = 2;

  const ceil = text.match(
    /(\d+(?:\.\d+)?)\s*(?:ft|foot|')\s*(?:ceil|ceiling)|ceil(?:ing)?\s*(?:height\s*)?(?:of\s*)?(\d+(?:\.\d+)?)/i
  );
  if (ceil) facts.ceilingFt = Number(ceil[1] || ceil[2]) || 8;

  return facts;
}

export function missingRequiredFacts(
  templateId: string,
  facts: QuoteFacts
): QuoteFactKey[] {
  const t = getTemplate(templateId);
  if (!t) return [];
  return t.requiredFacts.filter((k) => {
    const v = Number(facts[k]);
    return !(Number.isFinite(v) && v > 0);
  });
}

export function factQuestionsFor(
  templateId: string,
  missing: QuoteFactKey[]
): Array<{ key: QuoteFactKey; label: string }> {
  const t = getTemplate(templateId);
  return missing.map((key) => ({
    key,
    label: t?.factQuestions[key] || key,
  }));
}

function priceSfJob(input: {
  templateId: string;
  label: string;
  qty: number;
  baseRate: number;
  coats?: number;
  regional: RegionalPricing;
  materials: QuoteMaterial[];
  laborDescription: string;
  maxHours: number;
  preferredLaborRate?: number;
  breakdown: string;
  factsUsed: Record<string, number | string | boolean | null | undefined>;
}): LockedQuote {
  const coats = input.coats || 1;
  const cf = coatFactor(coats);
  const unitPrice = regionalSfRate(input.regional, input.baseRate, cf);
  const qty = Math.max(1, Math.round(input.qty));
  const jobTotal = roundMoney(unitPrice * qty);
  const rate =
    input.preferredLaborRate && input.preferredLaborRate >= 10
      ? input.preferredLaborRate
      : regionalLaborRate(input.regional, 62);

  const reconciled = reconcileQuote(
    jobTotal,
    input.materials,
    { description: input.laborDescription, rate },
    { maxHours: input.maxHours }
  );

  return {
    templateId: input.templateId,
    suggestedQty: qty,
    unit: 'SF',
    unitPrice: roundMoney(jobTotal / qty),
    total: reconciled.total,
    billingMode: 'sqft',
    materials: reconciled.materials,
    laborBreakdown: reconciled.labor,
    materialsCostTotal: reconciled.materialsCostTotal,
    laborCostTotal: reconciled.laborCostTotal,
    breakdown: input.breakdown,
    confidence: 'high',
    factsUsed: input.factsUsed,
  };
}

function paintMaterials(
  areaSqft: number,
  coats: number,
  regional: RegionalPricing,
  includePrimer: boolean,
  includeTexture: boolean
): QuoteMaterial[] {
  const paintGals = gallonsForArea(areaSqft, coats, 360);
  const primerGals = includePrimer
    ? gallonsForArea(Math.min(areaSqft, areaSqft * 0.35 + 200), 1, 300)
    : 0;
  const paintPrice = regionalMaterialPrice(regional, 34.98);
  const primerPrice = regionalMaterialPrice(regional, 26.98);
  const lines: QuoteMaterial[] = [
    materialLine(
      `Interior latex paint (${coats} coat${coats > 1 ? 's' : ''})`,
      paintGals,
      'gallon',
      paintPrice
    ),
  ];
  if (primerGals > 0) {
    lines.push(materialLine('Interior latex primer', primerGals, 'gallon', primerPrice));
  }
  if (includeTexture) {
    lines.push(
      materialLine(
        'Joint compound / texture blend',
        Math.max(1, Math.ceil(areaSqft / 800)),
        'tub',
        regionalMaterialPrice(regional, 18.98)
      )
    );
  }
  lines.push(
    materialLine(
      'Tape, rollers, brushes, drop cloths & supplies',
      1,
      'lot',
      regionalMaterialPrice(regional, Math.min(180, 45 + areaSqft / 40))
    )
  );
  return lines;
}

/** Price a locked template quote. Throws if required facts missing. */
export function priceTemplate(
  templateId: string,
  facts: QuoteFacts,
  regional: RegionalPricing,
  description = '',
  preferredLaborRate?: number
): LockedQuote {
  const missing = missingRequiredFacts(templateId, facts);
  if (missing.length) {
    throw new Error(`Missing facts: ${missing.join(', ')}`);
  }

  const text = description || '';
  const includeTexture = /texture|blend|skim/i.test(text);
  const includePrimer = /primer|prime\b|new\s*drywall|patch|texture/i.test(text);
  const rate =
    preferredLaborRate && preferredLaborRate >= 10
      ? preferredLaborRate
      : regionalLaborRate(regional, 62);

  switch (templateId) {
    case 'paint_interior_whole_home': {
      const floorSqft = Number(facts.floorSqft);
      const coats = Math.max(1, Math.min(3, Number(facts.coats) || 2));
      const ceilingFt = Number(facts.ceilingFt) || 8;
      const paintable = paintableFromFloor(floorSqft, ceilingFt);
      // Cap hours: ~floor/18 … floor/12 band for 2-coat whole home
      const maxHours = Math.min(90, Math.max(28, floorSqft / 16));
      const mats = paintMaterials(paintable, coats, regional, true, includeTexture);
      return priceSfJob({
        templateId,
        label: 'Interior paint — whole home',
        qty: floorSqft,
        baseRate: 2.15,
        coats,
        regional,
        materials: mats,
        laborDescription: `Prep, ${includeTexture ? 'texture blend, ' : ''}prime as needed, ${coats}-coat interior paint, cleanup`,
        maxHours,
        preferredLaborRate,
        breakdown: `Whole-home interior paint: ${floorSqft.toLocaleString()} SF floor, ~${paintable.toLocaleString()} SF surfaces, ${coats} coat(s).`,
        factsUsed: { floorSqft, coats, ceilingFt, paintableSqft: paintable },
      });
    }
    case 'paint_interior_walls': {
      const wallSqft = Number(facts.wallSqft);
      const coats = Math.max(1, Math.min(3, Number(facts.coats) || 2));
      const maxHours = Math.min(40, Math.max(3, wallSqft / 55));
      const mats = paintMaterials(wallSqft, coats, regional, includePrimer, includeTexture);
      return priceSfJob({
        templateId,
        label: 'Interior paint — walls',
        qty: wallSqft,
        baseRate: 1.95,
        coats,
        regional,
        materials: mats,
        laborDescription: `Prep, paint ${coats} coat(s) on walls, cleanup`,
        maxHours,
        preferredLaborRate,
        breakdown: `Interior wall paint: ${wallSqft.toLocaleString()} SF, ${coats} coat(s).`,
        factsUsed: { wallSqft, coats },
      });
    }
    case 'paint_exterior': {
      const areaSqft = Number(facts.areaSqft);
      const coats = Math.max(1, Math.min(3, Number(facts.coats) || 2));
      const paintGals = gallonsForArea(areaSqft, coats, 350);
      const mats = [
        materialLine(
          `Exterior paint (${coats} coat${coats > 1 ? 's' : ''})`,
          paintGals,
          'gallon',
          regionalMaterialPrice(regional, 42.98)
        ),
        materialLine(
          'Exterior supplies (tape, drop cloths, caulk)',
          1,
          'lot',
          regionalMaterialPrice(regional, Math.min(220, 60 + areaSqft / 35))
        ),
      ];
      return priceSfJob({
        templateId,
        label: 'Exterior paint',
        qty: areaSqft,
        baseRate: 2.35,
        coats,
        regional,
        materials: mats,
        laborDescription: `Exterior prep, ${coats}-coat paint, cleanup`,
        maxHours: Math.min(100, Math.max(8, areaSqft / 45)),
        preferredLaborRate,
        breakdown: `Exterior paint: ${areaSqft.toLocaleString()} SF, ${coats} coat(s).`,
        factsUsed: { areaSqft, coats },
      });
    }
    case 'texture_blend': {
      const areaSqft = Number(facts.areaSqft);
      const mats = [
        materialLine(
          'Joint compound / texture material',
          Math.max(1, Math.ceil(areaSqft / 400)),
          'tub',
          regionalMaterialPrice(regional, 18.98)
        ),
        materialLine('Sanding & prep supplies', 1, 'lot', regionalMaterialPrice(regional, 35)),
      ];
      return priceSfJob({
        templateId,
        label: 'Texture blend',
        qty: areaSqft,
        baseRate: 3.25,
        coats: 1,
        regional,
        materials: mats,
        laborDescription: 'Texture repair / blend, prep, cleanup',
        maxHours: Math.min(50, Math.max(2, areaSqft / 40)),
        preferredLaborRate,
        breakdown: `Texture blend: ${areaSqft.toLocaleString()} SF.`,
        factsUsed: { areaSqft },
      });
    }
    case 'drywall_area': {
      const areaSqft = Number(facts.areaSqft);
      const sheets = Math.max(1, Math.ceil((areaSqft * 1.1) / 32));
      const mats = [
        materialLine(
          '1/2 in. drywall sheet (4×8)',
          sheets,
          'sheet',
          regionalMaterialPrice(regional, 14.98)
        ),
        materialLine('Joint compound, tape & fasteners', 1, 'lot', regionalMaterialPrice(regional, 55 + areaSqft / 20)),
      ];
      return priceSfJob({
        templateId,
        label: 'Drywall',
        qty: areaSqft,
        baseRate: 8.75,
        regional,
        materials: mats,
        laborDescription: 'Hang, tape, mud, sand, finish',
        maxHours: Math.min(80, Math.max(4, areaSqft / 18)),
        preferredLaborRate,
        breakdown: `Drywall: ${areaSqft.toLocaleString()} SF (~${sheets} sheets).`,
        factsUsed: { areaSqft, sheetCount: sheets },
      });
    }
    case 'roofing': {
      const roofSqft = Number(facts.roofSqft);
      const squares = roofSqft / 100;
      const bundles = Math.max(3, Math.ceil(squares * 3 * 1.1));
      const mats = [
        materialLine(
          'Architectural shingles (bundle)',
          bundles,
          'bundle',
          regionalMaterialPrice(regional, 38.98)
        ),
        materialLine(
          'Underlayment, nails & ridge',
          1,
          'lot',
          regionalMaterialPrice(regional, 120 + squares * 25)
        ),
      ];
      return priceSfJob({
        templateId,
        label: 'Roofing',
        qty: roofSqft,
        baseRate: 4.9,
        regional,
        materials: mats,
        laborDescription: 'Tear-off as needed, underlayment, shingles, cleanup',
        maxHours: Math.min(120, Math.max(8, roofSqft / 35)),
        preferredLaborRate,
        breakdown: `Roofing: ${roofSqft.toLocaleString()} SF (~${squares.toFixed(1)} squares).`,
        factsUsed: { roofSqft },
      });
    }
    case 'flooring_lvp':
    case 'flooring_tile':
    case 'flooring_hardwood':
    case 'flooring_carpet':
    case 'flooring_general': {
      const areaSqft = Number(facts.areaSqft);
      const rates: Record<string, number> = {
        flooring_lvp: 3.1,
        flooring_tile: 4.75,
        flooring_hardwood: 6.25,
        flooring_carpet: 3.85,
        flooring_general: 2.95,
      };
      const matPerSf: Record<string, number> = {
        flooring_lvp: 2.79,
        flooring_tile: 2.98,
        flooring_hardwood: 4.98,
        flooring_carpet: 2.49,
        flooring_general: 2.29,
      };
      const mats = [
        materialLine(
          'Flooring material',
          roundMoney(areaSqft * 1.1),
          'sqft',
          regionalMaterialPrice(regional, matPerSf[templateId] || 2.5)
        ),
        materialLine('Underlayment / supplies', 1, 'lot', regionalMaterialPrice(regional, 40 + areaSqft / 25)),
      ];
      return priceSfJob({
        templateId,
        label: getTemplate(templateId)?.label || 'Flooring',
        qty: areaSqft,
        baseRate: rates[templateId] || 3,
        regional,
        materials: mats,
        laborDescription: 'Floor prep, install, transitions, cleanup',
        maxHours: Math.min(80, Math.max(4, areaSqft / 22)),
        preferredLaborRate,
        breakdown: `Flooring: ${areaSqft.toLocaleString()} SF.`,
        factsUsed: { areaSqft },
      });
    }
    case 'siding': {
      const areaSqft = Number(facts.areaSqft);
      const mats = [
        materialLine(
          'Siding material',
          roundMoney(areaSqft * 1.08),
          'sqft',
          regionalMaterialPrice(regional, 3.25)
        ),
        materialLine('Trim, wrap & fasteners', 1, 'lot', regionalMaterialPrice(regional, 80 + areaSqft / 20)),
      ];
      return priceSfJob({
        templateId,
        label: 'Siding',
        qty: areaSqft,
        baseRate: 5.1,
        regional,
        materials: mats,
        laborDescription: 'Remove as needed, install siding, trim, cleanup',
        maxHours: Math.min(100, Math.max(6, areaSqft / 22)),
        preferredLaborRate,
        breakdown: `Siding: ${areaSqft.toLocaleString()} SF.`,
        factsUsed: { areaSqft },
      });
    }
    case 'insulation': {
      const areaSqft = Number(facts.areaSqft);
      const mats = [
        materialLine(
          'Insulation',
          roundMoney(areaSqft * 1.05),
          'sqft',
          regionalMaterialPrice(regional, 0.85)
        ),
      ];
      return priceSfJob({
        templateId,
        label: 'Insulation',
        qty: areaSqft,
        baseRate: 2.05,
        regional,
        materials: mats,
        laborDescription: 'Install insulation, cleanup',
        maxHours: Math.min(40, Math.max(2, areaSqft / 50)),
        preferredLaborRate,
        breakdown: `Insulation: ${areaSqft.toLocaleString()} SF.`,
        factsUsed: { areaSqft },
      });
    }
    case 'concrete': {
      const areaSqft = Number(facts.areaSqft);
      const mats = [
        materialLine(
          'Concrete & base materials',
          1,
          'lot',
          regionalMaterialPrice(regional, Math.max(200, areaSqft * 2.2))
        ),
      ];
      return priceSfJob({
        templateId,
        label: 'Concrete',
        qty: areaSqft,
        baseRate: 9,
        regional,
        materials: mats,
        laborDescription: 'Form, pour, finish, cleanup',
        maxHours: Math.min(60, Math.max(4, areaSqft / 25)),
        preferredLaborRate,
        breakdown: `Concrete: ${areaSqft.toLocaleString()} SF.`,
        factsUsed: { areaSqft },
      });
    }
    case 'unit_task':
    default: {
      const band = detectTaskMarketBand(text);
      const regBand = band ? regionalizeTaskBand(band, regional) : null;
      const jobTotal = roundMoney(regBand?.midTotal || 350 * (regional.laborMultiplier || 1));
      const mats = [
        materialLine(
          'Materials & supplies',
          1,
          'lot',
          roundMoney(jobTotal * 0.32)
        ),
      ];
      const reconciled = reconcileQuote(
        jobTotal,
        mats,
        {
          description: regBand?.label || 'Labor',
          rate,
        },
        { maxHours: regBand?.maxHours || 12, minMaterialShare: 0.2, maxMaterialShare: 0.45 }
      );
      return {
        templateId: 'unit_task',
        suggestedQty: 1,
        unit: 'Unit',
        unitPrice: reconciled.total,
        total: reconciled.total,
        billingMode: 'unit',
        materials: reconciled.materials,
        laborBreakdown: reconciled.labor,
        materialsCostTotal: reconciled.materialsCostTotal,
        laborCostTotal: reconciled.laborCostTotal,
        breakdown: regBand
          ? `Unit job: ${regBand.label} (mid-market installed).`
          : 'General unit job (mid-market installed).',
        confidence: band ? 'high' : 'medium',
        factsUsed: { quantity: 1 },
      };
    }
  }
}

// silence unused import if tree-shaken oddly
void crewHoursFromProduction;
