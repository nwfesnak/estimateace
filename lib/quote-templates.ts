/**
 * Residential quote templates — fixed formulas set the price.
 * AI only classifies into a templateId + facts; this module prices.
 */
import type { RegionalPricing } from './ai-quote-region';
import { detectTaskMarketBand, regionalizeTaskBand } from './task-market-pricing';
import {
  coatFactor,
  gallonsForArea,
  materialLine,
  paintableFromFloor,
  reconcileQuote,
  regionalLaborRate,
  regionalMaterialPrice,
  regionalLfRate,
  regionalSfRate,
  regionalUnitTotal,
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
  | 'linearFeet'
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
  // —— Landscaping ——
  {
    id: 'landscaping_sod',
    trade: 'landscaping',
    label: 'Landscaping — sod / lawn',
    requiredFacts: ['areaSqft'],
    factQuestions: { areaSqft: 'Lawn / sod area (sq ft)' },
    detect: /\bsod\b|new\s*lawn|turf|hydroseed|grass\s*install/i,
    priority: 92,
    billing: 'sf',
  },
  {
    id: 'landscaping_mulch',
    trade: 'landscaping',
    label: 'Landscaping — mulch / beds',
    requiredFacts: ['areaSqft'],
    factQuestions: { areaSqft: 'Bed / mulch area (sq ft)' },
    detect: /mulch|flower\s*bed|landscape\s*bed|garden\s*bed/i,
    priority: 88,
    billing: 'sf',
  },
  {
    id: 'landscaping_general',
    trade: 'landscaping',
    label: 'Landscaping — general',
    requiredFacts: ['areaSqft'],
    factQuestions: { areaSqft: 'Landscape area (sq ft)' },
    detect: /landscap|grading|plantings?|shrub|hedge|hardscape|paver|retaining\s*wall/i,
    priority: 78,
    billing: 'sf',
  },
  {
    id: 'irrigation',
    trade: 'landscaping',
    label: 'Irrigation / sprinkler system',
    requiredFacts: ['areaSqft'],
    factQuestions: { areaSqft: 'Yard area covered (sq ft)' },
    detect: /irrigation|sprinkler\s*system|lawn\s*sprinkler/i,
    priority: 90,
    billing: 'sf',
  },
  // —— Fencing / gutters / deck (LF or SF) ——
  {
    id: 'fencing',
    trade: 'fencing',
    label: 'Fence install / replace',
    requiredFacts: ['linearFeet'],
    factQuestions: { linearFeet: 'Fence length (linear feet)' },
    detect: /fence|fencing|privacy\s*fence|picket\s*fence/i,
    priority: 93,
    billing: 'sf', // billed as Unit×LF via custom; use SF label as LF qty
  },
  {
    id: 'gutters',
    trade: 'gutters',
    label: 'Gutters / downspouts',
    requiredFacts: ['linearFeet'],
    factQuestions: { linearFeet: 'Gutter length (linear feet)' },
    detect: /gutter|downspout|eavestrough/i,
    priority: 91,
    billing: 'sf',
  },
  {
    id: 'deck_build',
    trade: 'carpentry',
    label: 'Deck build / rebuild',
    requiredFacts: ['areaSqft'],
    factQuestions: { areaSqft: 'Deck area (sq ft)' },
    detect: /(?:build|new|rebuild|construct)\s+(?:a\s+)?deck|deck\s*(?:build|framing|rebuild)|composite\s*deck/i,
    priority: 94,
    billing: 'sf',
  },
  {
    id: 'deck_stain',
    trade: 'carpentry',
    label: 'Deck stain / seal',
    requiredFacts: ['areaSqft'],
    factQuestions: { areaSqft: 'Deck area (sq ft)' },
    detect: /deck\s*(?:stain|seal|sealing|refinish)|stain(?:ing)?\s+(?:the\s+)?deck/i,
    priority: 89,
    billing: 'sf',
  },
  // —— Plumbing (area / LF / unit) ——
  {
    id: 'plumbing_water_line',
    trade: 'plumbing',
    label: 'Plumbing — water / drain line',
    requiredFacts: ['linearFeet'],
    factQuestions: { linearFeet: 'Pipe run length (linear feet)' },
    detect:
      /(?:water|supply|drain|sewer|waste)\s*line|re[\s-]?pipe|repipe|copper\s*(?:to\s*)?pex|pex\s*(?:replac|install)|drain\s*line|sewer\s*(?:line|repair)/i,
    priority: 96,
    billing: 'sf',
  },
  {
    id: 'plumbing_fixture',
    trade: 'plumbing',
    label: 'Plumbing — fixture install',
    requiredFacts: [],
    factQuestions: {},
    detect:
      /plumb|toilet|faucet|disposal|water\s*heater|sump|shower\s*valve|vanity|sink\s*(?:replac|install)|tub\s*(?:replac|install)/i,
    priority: 72,
    billing: 'unit',
  },
  // —— Electrical ——
  {
    id: 'electrical_circuit',
    trade: 'electrical',
    label: 'Electrical — new circuit / run',
    requiredFacts: ['linearFeet'],
    factQuestions: { linearFeet: 'Approximate wire run (linear feet)' },
    detect:
      /new\s*circuit|circuit\s*run|wire\s*run|rewire|sub[\s-]?panel|panel\s*(?:upgrade|replace)|add\s*(?:a\s+)?circuit/i,
    priority: 97,
    billing: 'sf',
  },
  {
    id: 'electrical_fixture',
    trade: 'electrical',
    label: 'Electrical — fixture / device',
    requiredFacts: [],
    factQuestions: {},
    detect:
      /electric|outlet|receptacle|switch|gfci|gfi|ceiling\s*fan|light\s*fixture|chandelier|ev\s*charger|thermostat|recessed/i,
    priority: 71,
    billing: 'unit',
  },
  // —— HVAC ——
  {
    id: 'hvac_system',
    trade: 'hvac',
    label: 'HVAC — system replace / install',
    requiredFacts: [],
    factQuestions: { quantity: 'Number of systems / units (usually 1)' },
    detect:
      /hvac|mini[\s-]?split|heat\s*pump|central\s*air|ac\s*(?:unit|condens|install|replac)|furnace\s*(?:install|replac)|air\s*handler/i,
    priority: 98,
    billing: 'unit',
  },
  {
    id: 'hvac_duct',
    trade: 'hvac',
    label: 'HVAC — ductwork',
    requiredFacts: ['linearFeet'],
    factQuestions: { linearFeet: 'Duct run length (linear feet)' },
    detect: /duct(?:work)?|duct\s*(?:run|replac|seal|clean)/i,
    priority: 90,
    billing: 'sf',
  },
  // —— Carpentry / doors / windows (area or unit) ——
  {
    id: 'carpentry_trim',
    trade: 'carpentry',
    label: 'Trim / baseboard',
    requiredFacts: ['linearFeet'],
    factQuestions: { linearFeet: 'Trim length (linear feet)' },
    detect: /baseboard|crown\s*mold|door\s*casing|trim\s*(?:install|replac)|quarter\s*round/i,
    priority: 87,
    billing: 'sf',
  },
  {
    id: 'tile_shower',
    trade: 'tile',
    label: 'Tile shower / surround',
    requiredFacts: ['areaSqft'],
    factQuestions: { areaSqft: 'Tile area (sq ft)' },
    detect: /tile\s*shower|shower\s*(?:tile|surround)|tub\s*surround|bathroom\s*tile/i,
    priority: 92,
    billing: 'sf',
  },
  {
    id: 'masonry',
    trade: 'masonry',
    label: 'Masonry / brick / block',
    requiredFacts: ['areaSqft'],
    factQuestions: { areaSqft: 'Masonry area (sq ft)' },
    detect: /masonry|brick\s*(?:work|repair|veneer)|block\s*wall|stone\s*(?:veneer|wall)|tuck[\s-]?point/i,
    priority: 88,
    billing: 'sf',
  },
  {
    id: 'pressure_wash',
    trade: 'cleaning',
    label: 'Pressure washing',
    requiredFacts: ['areaSqft'],
    factQuestions: { areaSqft: 'Area to wash (sq ft)' },
    detect: /pressure\s*wash|power\s*wash|soft\s*wash/i,
    priority: 84,
    billing: 'sf',
  },
  {
    id: 'cleaning_general',
    trade: 'cleaning',
    label: 'Cleaning / junk / haul',
    requiredFacts: [],
    factQuestions: {},
    detect: /clean(?:ing)?|junk\s*remov|haul[\s-]?away|debris\s*remov|estate\s*clean/i,
    priority: 55,
    billing: 'unit',
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

  // High-confidence specialty trades first (before generic paint/drywall)
  const orderedFirst = [
    'hvac_system',
    'hvac_duct',
    'electrical_circuit',
    'plumbing_water_line',
    'roofing',
    'fencing',
    'deck_build',
    'gutters',
    'irrigation',
    'landscaping_sod',
    'tile_shower',
    'masonry',
    'carpentry_trim',
    'deck_stain',
    'landscaping_mulch',
    'pressure_wash',
    'siding',
    'concrete',
    'insulation',
  ];
  for (const id of orderedFirst) {
    const t = getTemplate(id);
    if (t?.detect.test(text)) return id;
  }

  const whole = detectWholeHomeInteriorPaint(text);
  if (whole) return 'paint_interior_whole_home';

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

  // Fixture-level plumbing / electrical before area flooring catch-alls
  if (getTemplate('plumbing_fixture')!.detect.test(text) && !/remodel|whole\s*bath/i.test(text)) {
    const band = detectTaskMarketBand(text);
    if (band || /toilet|faucet|disposal|water\s*heater|sump|shower\s*valve/i.test(text)) {
      return 'plumbing_fixture';
    }
  }
  if (getTemplate('electrical_fixture')!.detect.test(text)) {
    const band = detectTaskMarketBand(text);
    if (
      band ||
      /outlet|switch|gfci|ceiling\s*fan|light\s*fixture|thermostat|ev\s*charger/i.test(text)
    ) {
      return 'electrical_fixture';
    }
  }

  const scored = QUOTE_TEMPLATES.filter(
    (t) =>
      t.id !== 'unit_task' &&
      t.id !== 'paint_interior_whole_home' &&
      t.id !== 'plumbing_fixture' &&
      t.id !== 'electrical_fixture'
  )
    .filter((t) => t.detect.test(text))
    .sort((a, b) => b.priority - a.priority);

  if (scored[0]) {
    if (
      scored[0].id.startsWith('paint') &&
      !/whole|entire|home|house|bedroom|bath/i.test(text)
    ) {
      return 'paint_interior_walls';
    }
    if (scored[0].trade === 'paint' && (parsePrimaryFloorSqft(text) || 0) >= 400) {
      return 'paint_interior_whole_home';
    }
    if (
      scored[0].id === 'texture_blend' &&
      /paint|two\s*coat|2\s*coat/i.test(text) &&
      (parsePrimaryFloorSqft(text) || 0) >= 400
    ) {
      return 'paint_interior_whole_home';
    }
    return scored[0].id;
  }

  if (detectTaskMarketBand(text)) return 'unit_task';
  if (/plumb/i.test(text)) return 'plumbing_fixture';
  if (/electric/i.test(text)) return 'electrical_fixture';
  if (/landscap|yard|lawn/i.test(text)) return 'landscaping_general';
  if (/hvac|heat|air\s*condition/i.test(text)) return 'hvac_system';
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

  // Linear feet: "120 lf", "80 linear feet", "50 ft of fence"
  const lfMatch =
    text.match(/(\d[\d,]*)\s*(?:lf|l\.?f\.?|lin(?:ear)?\s*(?:ft|feet|foot))\b/i) ||
    text.match(/(\d[\d,]*)\s*(?:ft|feet|foot)\s+(?:of\s+)?(?:fence|gutter|pipe|duct|trim|baseboard|wire|run)/i) ||
    text.match(/(?:fence|gutter|pipe|duct|trim|baseboard|wire|run).{0,40}?(\d[\d,]*)\s*(?:ft|feet|lf)\b/i);
  if (lfMatch) {
    const lf = Number(String(lfMatch[1]).replace(/,/g, ''));
    if (lf > 0) facts.linearFeet = lf;
  }

  if (/three\s*coat|3\s*coat/i.test(text)) facts.coats = 3;
  else if (/two\s*coat|2\s*coat|full\s*coats?|dual[\s-]*coat/i.test(text)) facts.coats = 2;
  else if (facts.coats == null && /paint|coat/i.test(text)) facts.coats = 2;

  const ceil = text.match(
    /(\d+(?:\.\d+)?)\s*(?:ft|foot|')\s*(?:ceil|ceiling)|ceil(?:ing)?\s*(?:height\s*)?(?:of\s*)?(\d+(?:\.\d+)?)/i
  );
  if (ceil) facts.ceilingFt = Number(ceil[1] || ceil[2]) || 8;

  if (!facts.quantity) facts.quantity = 1;

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

function priceLfJob(input: {
  templateId: string;
  qty: number;
  baseRatePerLf: number;
  regional: RegionalPricing;
  materials: QuoteMaterial[];
  laborDescription: string;
  maxHours: number;
  preferredLaborRate?: number;
  breakdown: string;
  factsUsed: Record<string, number | string | boolean | null | undefined>;
  laborRateBase?: number;
}): LockedQuote {
  const qty = Math.max(1, Math.round(input.qty));
  const unitPrice = regionalLfRate(input.regional, input.baseRatePerLf);
  const jobTotal = roundMoney(unitPrice * qty);
  const rate =
    input.preferredLaborRate && input.preferredLaborRate >= 10
      ? input.preferredLaborRate
      : regionalLaborRate(input.regional, input.laborRateBase || 65);

  const reconciled = reconcileQuote(
    jobTotal,
    input.materials,
    { description: input.laborDescription, rate },
    { maxHours: input.maxHours }
  );

  return {
    templateId: input.templateId,
    suggestedQty: qty,
    unit: 'LF',
    unitPrice: roundMoney(jobTotal / qty),
    total: reconciled.total,
    billingMode: 'lf',
    materials: reconciled.materials,
    laborBreakdown: reconciled.labor,
    materialsCostTotal: reconciled.materialsCostTotal,
    laborCostTotal: reconciled.laborCostTotal,
    breakdown: input.breakdown,
    confidence: 'high',
    factsUsed: input.factsUsed,
  };
}

function priceUnitJob(input: {
  templateId: string;
  nationalMid: number;
  regional: RegionalPricing;
  materials?: QuoteMaterial[];
  laborDescription: string;
  maxHours: number;
  preferredLaborRate?: number;
  breakdown: string;
  factsUsed?: Record<string, number | string | boolean | null | undefined>;
  laborRateBase?: number;
  quantity?: number;
}): LockedQuote {
  const qty = Math.max(1, Math.round(input.quantity || 1));
  const jobTotal = roundMoney(regionalUnitTotal(input.regional, input.nationalMid) * qty);
  const rate =
    input.preferredLaborRate && input.preferredLaborRate >= 10
      ? input.preferredLaborRate
      : regionalLaborRate(input.regional, input.laborRateBase || 70);
  const mats =
    input.materials && input.materials.length
      ? input.materials
      : [materialLine('Materials & supplies', 1, 'lot', roundMoney(jobTotal * 0.35))];

  const reconciled = reconcileQuote(
    jobTotal,
    mats,
    { description: input.laborDescription, rate },
    { maxHours: input.maxHours * qty, minMaterialShare: 0.2, maxMaterialShare: 0.5 }
  );

  return {
    templateId: input.templateId,
    suggestedQty: qty,
    unit: 'Unit',
    unitPrice: roundMoney(jobTotal / qty),
    total: reconciled.total,
    billingMode: 'unit',
    materials: reconciled.materials,
    laborBreakdown: reconciled.labor,
    materialsCostTotal: reconciled.materialsCostTotal,
    laborCostTotal: reconciled.laborCostTotal,
    breakdown: input.breakdown,
    confidence: 'high',
    factsUsed: input.factsUsed || { quantity: qty },
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
    case 'landscaping_sod': {
      const areaSqft = Number(facts.areaSqft);
      const mats = [
        materialLine('Sod', roundMoney(areaSqft * 1.05), 'sqft', regionalMaterialPrice(regional, 0.55)),
        materialLine('Soil prep / supplies', 1, 'lot', regionalMaterialPrice(regional, 40 + areaSqft / 40)),
      ];
      return priceSfJob({
        templateId,
        label: 'Sod',
        qty: areaSqft,
        baseRate: 1.35,
        regional,
        materials: mats,
        laborDescription: 'Grade, lay sod, cleanup',
        maxHours: Math.min(40, Math.max(3, areaSqft / 120)),
        preferredLaborRate,
        breakdown: `Sod / lawn: ${areaSqft.toLocaleString()} SF.`,
        factsUsed: { areaSqft },
      });
    }
    case 'landscaping_mulch': {
      const areaSqft = Number(facts.areaSqft);
      const mats = [
        materialLine('Mulch / bed material', 1, 'lot', regionalMaterialPrice(regional, Math.max(80, areaSqft * 0.45))),
      ];
      return priceSfJob({
        templateId,
        label: 'Mulch beds',
        qty: areaSqft,
        baseRate: 1.15,
        regional,
        materials: mats,
        laborDescription: 'Bed prep, mulch install, cleanup',
        maxHours: Math.min(24, Math.max(2, areaSqft / 150)),
        preferredLaborRate,
        breakdown: `Mulch / beds: ${areaSqft.toLocaleString()} SF.`,
        factsUsed: { areaSqft },
      });
    }
    case 'landscaping_general': {
      const areaSqft = Number(facts.areaSqft);
      const mats = [
        materialLine('Landscape materials', 1, 'lot', regionalMaterialPrice(regional, Math.max(120, areaSqft * 0.8))),
      ];
      return priceSfJob({
        templateId,
        label: 'Landscaping',
        qty: areaSqft,
        baseRate: 3.5,
        regional,
        materials: mats,
        laborDescription: 'Landscape install / grading / plantings',
        maxHours: Math.min(50, Math.max(3, areaSqft / 80)),
        preferredLaborRate,
        breakdown: `Landscaping: ${areaSqft.toLocaleString()} SF.`,
        factsUsed: { areaSqft },
      });
    }
    case 'irrigation': {
      const areaSqft = Number(facts.areaSqft);
      const mats = [
        materialLine('Irrigation parts & pipe', 1, 'lot', regionalMaterialPrice(regional, Math.max(200, areaSqft * 0.35))),
      ];
      return priceSfJob({
        templateId,
        label: 'Irrigation',
        qty: areaSqft,
        baseRate: 1.1,
        regional,
        materials: mats,
        laborDescription: 'Irrigation layout, pipe, heads, test',
        maxHours: Math.min(40, Math.max(4, areaSqft / 200)),
        preferredLaborRate,
        breakdown: `Irrigation: ${areaSqft.toLocaleString()} SF coverage.`,
        factsUsed: { areaSqft },
      });
    }
    case 'fencing': {
      const lf = Number(facts.linearFeet);
      const mats = [
        materialLine('Fence panels / posts / hardware', 1, 'lot', regionalMaterialPrice(regional, Math.max(150, lf * 12))),
      ];
      return priceLfJob({
        templateId,
        qty: lf,
        baseRatePerLf: 28,
        regional,
        materials: mats,
        laborDescription: 'Fence install / replace, cleanup',
        maxHours: Math.min(80, Math.max(4, lf / 8)),
        preferredLaborRate,
        breakdown: `Fence: ${lf.toLocaleString()} LF.`,
        factsUsed: { linearFeet: lf },
      });
    }
    case 'gutters': {
      const lf = Number(facts.linearFeet);
      const mats = [
        materialLine('Gutter / downspout material', 1, 'lot', regionalMaterialPrice(regional, Math.max(80, lf * 4.5))),
      ];
      return priceLfJob({
        templateId,
        qty: lf,
        baseRatePerLf: 12,
        regional,
        materials: mats,
        laborDescription: 'Gutter install / replace, seal, cleanup',
        maxHours: Math.min(40, Math.max(2, lf / 20)),
        preferredLaborRate,
        breakdown: `Gutters: ${lf.toLocaleString()} LF.`,
        factsUsed: { linearFeet: lf },
      });
    }
    case 'deck_build': {
      const areaSqft = Number(facts.areaSqft);
      const mats = [
        materialLine('Deck lumber / composite & fasteners', 1, 'lot', regionalMaterialPrice(regional, Math.max(400, areaSqft * 8))),
      ];
      return priceSfJob({
        templateId,
        label: 'Deck build',
        qty: areaSqft,
        baseRate: 28,
        regional,
        materials: mats,
        laborDescription: 'Deck framing, decking, railings, cleanup',
        maxHours: Math.min(120, Math.max(8, areaSqft / 12)),
        preferredLaborRate,
        breakdown: `Deck build: ${areaSqft.toLocaleString()} SF.`,
        factsUsed: { areaSqft },
      });
    }
    case 'deck_stain': {
      const areaSqft = Number(facts.areaSqft);
      const mats = [
        materialLine('Deck stain / sealer', Math.max(1, Math.ceil(areaSqft / 250)), 'gallon', regionalMaterialPrice(regional, 38.98)),
        materialLine('Prep supplies', 1, 'lot', regionalMaterialPrice(regional, 35)),
      ];
      return priceSfJob({
        templateId,
        label: 'Deck stain',
        qty: areaSqft,
        baseRate: 2.75,
        regional,
        materials: mats,
        laborDescription: 'Deck prep, stain/seal, cleanup',
        maxHours: Math.min(30, Math.max(3, areaSqft / 80)),
        preferredLaborRate,
        breakdown: `Deck stain: ${areaSqft.toLocaleString()} SF.`,
        factsUsed: { areaSqft },
      });
    }
    case 'plumbing_water_line': {
      const lf = Number(facts.linearFeet);
      const mats = [
        materialLine('Pipe, fittings & valves', 1, 'lot', regionalMaterialPrice(regional, Math.max(60, lf * 6))),
      ];
      return priceLfJob({
        templateId,
        qty: lf,
        baseRatePerLf: 22,
        regional,
        materials: mats,
        laborDescription: 'Plumbing line install / repair, test',
        maxHours: Math.min(40, Math.max(2, lf / 15)),
        preferredLaborRate,
        laborRateBase: 78,
        breakdown: `Plumbing line: ${lf.toLocaleString()} LF.`,
        factsUsed: { linearFeet: lf },
      });
    }
    case 'plumbing_fixture': {
      const band = detectTaskMarketBand(text);
      return priceUnitJob({
        templateId,
        nationalMid: band ? band.midTotal : 420,
        regional,
        laborDescription: band?.label || 'Plumbing fixture labor',
        maxHours: band?.maxHours || 6,
        preferredLaborRate,
        laborRateBase: 80,
        breakdown: band ? `Plumbing: ${band.label}.` : 'Plumbing fixture install (mid-market).',
        quantity: Number(facts.quantity) || 1,
      });
    }
    case 'electrical_circuit': {
      const lf = Number(facts.linearFeet);
      const mats = [
        materialLine('Wire, boxes & devices', 1, 'lot', regionalMaterialPrice(regional, Math.max(80, lf * 3.5))),
      ];
      return priceLfJob({
        templateId,
        qty: lf,
        baseRatePerLf: 18,
        regional,
        materials: mats,
        laborDescription: 'Electrical circuit / wire run, devices, test',
        maxHours: Math.min(40, Math.max(2, lf / 18)),
        preferredLaborRate,
        laborRateBase: 85,
        breakdown: `Electrical run: ${lf.toLocaleString()} LF.`,
        factsUsed: { linearFeet: lf },
      });
    }
    case 'electrical_fixture': {
      const band = detectTaskMarketBand(text);
      return priceUnitJob({
        templateId,
        nationalMid: band?.midTotal || 320,
        regional,
        laborDescription: band?.label || 'Electrical fixture labor',
        maxHours: band?.maxHours || 5,
        preferredLaborRate,
        laborRateBase: 82,
        breakdown: band ? `Electrical: ${band.label}.` : 'Electrical fixture/device (mid-market).',
        quantity: Number(facts.quantity) || 1,
      });
    }
    case 'hvac_system': {
      return priceUnitJob({
        templateId,
        nationalMid: /mini[\s-]?split/i.test(text) ? 4500 : 7500,
        regional,
        laborDescription: 'HVAC system install / replace',
        maxHours: 24,
        preferredLaborRate,
        laborRateBase: 95,
        breakdown: /mini[\s-]?split/i.test(text)
          ? 'Mini-split system install (mid-market).'
          : 'HVAC system install/replace (mid-market).',
        quantity: Number(facts.quantity) || 1,
        materials: [
          materialLine('HVAC equipment & materials', 1, 'lot', regionalMaterialPrice(regional, /mini[\s-]?split/i.test(text) ? 2200 : 3800)),
        ],
      });
    }
    case 'hvac_duct': {
      const lf = Number(facts.linearFeet);
      const mats = [
        materialLine('Duct / flex / fittings', 1, 'lot', regionalMaterialPrice(regional, Math.max(100, lf * 8))),
      ];
      return priceLfJob({
        templateId,
        qty: lf,
        baseRatePerLf: 28,
        regional,
        materials: mats,
        laborDescription: 'Ductwork install / repair',
        maxHours: Math.min(40, Math.max(3, lf / 12)),
        preferredLaborRate,
        laborRateBase: 90,
        breakdown: `Ductwork: ${lf.toLocaleString()} LF.`,
        factsUsed: { linearFeet: lf },
      });
    }
    case 'carpentry_trim': {
      const lf = Number(facts.linearFeet);
      const mats = [
        materialLine('Trim / baseboard material', 1, 'lot', regionalMaterialPrice(regional, Math.max(40, lf * 2.2))),
      ];
      return priceLfJob({
        templateId,
        qty: lf,
        baseRatePerLf: 8.5,
        regional,
        materials: mats,
        laborDescription: 'Trim install, cope/cut, nail, caulk',
        maxHours: Math.min(30, Math.max(2, lf / 25)),
        preferredLaborRate,
        breakdown: `Trim: ${lf.toLocaleString()} LF.`,
        factsUsed: { linearFeet: lf },
      });
    }
    case 'tile_shower': {
      const areaSqft = Number(facts.areaSqft);
      const mats = [
        materialLine('Tile', roundMoney(areaSqft * 1.12), 'sqft', regionalMaterialPrice(regional, 3.98)),
        materialLine('Thinset, grout, membrane', 1, 'lot', regionalMaterialPrice(regional, 80 + areaSqft * 0.8)),
      ];
      return priceSfJob({
        templateId,
        label: 'Tile shower',
        qty: areaSqft,
        baseRate: 18,
        regional,
        materials: mats,
        laborDescription: 'Waterproof, tile, grout, cleanup',
        maxHours: Math.min(50, Math.max(4, areaSqft / 8)),
        preferredLaborRate,
        breakdown: `Tile shower/surround: ${areaSqft.toLocaleString()} SF.`,
        factsUsed: { areaSqft },
      });
    }
    case 'masonry': {
      const areaSqft = Number(facts.areaSqft);
      const mats = [
        materialLine('Brick/block/stone & mortar', 1, 'lot', regionalMaterialPrice(regional, Math.max(150, areaSqft * 4))),
      ];
      return priceSfJob({
        templateId,
        label: 'Masonry',
        qty: areaSqft,
        baseRate: 22,
        regional,
        materials: mats,
        laborDescription: 'Masonry repair / install',
        maxHours: Math.min(60, Math.max(3, areaSqft / 10)),
        preferredLaborRate,
        breakdown: `Masonry: ${areaSqft.toLocaleString()} SF.`,
        factsUsed: { areaSqft },
      });
    }
    case 'pressure_wash': {
      const areaSqft = Number(facts.areaSqft);
      const mats = [materialLine('Cleaners & supplies', 1, 'lot', regionalMaterialPrice(regional, 25))];
      return priceSfJob({
        templateId,
        label: 'Pressure wash',
        qty: areaSqft,
        baseRate: 0.45,
        regional,
        materials: mats,
        laborDescription: 'Pressure / soft wash, cleanup',
        maxHours: Math.min(16, Math.max(1.5, areaSqft / 400)),
        preferredLaborRate,
        breakdown: `Pressure washing: ${areaSqft.toLocaleString()} SF.`,
        factsUsed: { areaSqft },
      });
    }
    case 'cleaning_general': {
      return priceUnitJob({
        templateId,
        nationalMid: 275,
        regional,
        laborDescription: 'Cleaning / haul-away labor',
        maxHours: 8,
        preferredLaborRate,
        breakdown: 'Cleaning / junk haul (mid-market).',
        quantity: Number(facts.quantity) || 1,
      });
    }
    case 'unit_task':
    default: {
      const band = detectTaskMarketBand(text);
      const regBand = band ? regionalizeTaskBand(band, regional) : null;
      // Trade-aware fallback when no specific band matched
      let fallbackMid = 350;
      if (/plumb/i.test(text)) fallbackMid = 420;
      else if (/electric/i.test(text)) fallbackMid = 380;
      else if (/hvac|furnace|heat\s*pump/i.test(text)) fallbackMid = 550;
      else if (/landscap|yard|lawn/i.test(text)) fallbackMid = 400;
      else if (/carpentry|door|window|trim/i.test(text)) fallbackMid = 380;

      const nationalMid = band?.midTotal || fallbackMid;
      const jobTotal = roundMoney(
        regBand?.midTotal || regionalUnitTotal(regional, nationalMid)
      );
      const mats = [
        materialLine('Materials & supplies', 1, 'lot', roundMoney(jobTotal * 0.32)),
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
        templateId: templateId === 'unit_task' ? 'unit_task' : templateId,
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
          : 'General trade job (mid-market installed).',
        confidence: band ? 'high' : 'medium',
        factsUsed: { quantity: 1 },
      };
    }
  }
}
