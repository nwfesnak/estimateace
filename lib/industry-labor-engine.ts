/**
 * Multi-industry labor engine — source of truth for AI Price Quote hours.
 *
 * Architecture (all trades):
 * 1) Detect trade + measure (sqft / lf / each)
 * 2) Detect which WORK PHASES apply (demo, hang, finish, paint, …)
 * 3) Hours = sum(quantity ÷ production rate) per phase + mobilization
 * 4) Rate = trade-typical hourly (regional multiplier applied by caller)
 *
 * The LLM may suggest scope/materials; it must NOT invent under-hour labor.
 * Production rates are conservative residential crew-hours (US mid-market).
 */

import { parseSqftFromDescription } from './quote-units';

const roundMoney = (n: number) => Math.round(n * 100) / 100;

export type LaborMeasure = 'sqft' | 'lf' | 'ea' | 'job';

export type IndustryLaborResult = {
  tradeId: string;
  tradeLabel: string;
  measure: LaborMeasure;
  quantity: number;
  minHours: number;
  expectedHours: number;
  maxHours: number;
  typicalRate: number;
  maxRate: number;
  phases: Array<{ id: string; label: string; hours: number }>;
  notes: string;
};

type PhaseDef = {
  id: string;
  label: string;
  /** If true, always run when trade matches. Else match detect on description. */
  always?: boolean;
  detect?: RegExp;
  /**
   * Production: how many measure-units one crew finishes per hour in this phase.
   * Higher = faster. Hours for phase = quantity / unitsPerHour.
   */
  unitsPerHour: number;
  /** Ceiling / ladder / confined — multiply hours */
  hardAccessMult?: number;
  fixedHours?: number;
};

type IndustryDef = {
  id: string;
  label: string;
  detect: RegExp;
  exclude?: RegExp;
  measure: LaborMeasure;
  /** Prefer this measure quantity from line qty when unit matches */
  typicalRate: number;
  maxRate: number;
  minJobHours: number;
  /** Optional installed $ per measure unit (mid) for sanity checks */
  midInstalledPerUnit?: number;
  phases: PhaseDef[];
  /** If no phase matches, use this overall production (units/hr) */
  fallbackUnitsPerHour: number;
};

/**
 * Production libraries by trade.
 * Rates are total CREW-HOURS (not calendar days with a 3-person crew).
 */
const INDUSTRIES: IndustryDef[] = [
  // ——— Drywall ———
  {
    id: 'drywall',
    label: 'Drywall',
    detect: /drywall|sheetrock|gypsum|hang\s*rock|\bmud\b|joint\s*compound|tape\s*(?:and|&)?\s*(?:mud|finish)/i,
    measure: 'sqft',
    typicalRate: 62,
    maxRate: 78,
    minJobHours: 2,
    midInstalledPerUnit: 8.5,
    fallbackUnitsPerHour: 14,
    phases: [
      {
        id: 'demo',
        label: 'Demo / remove board',
        detect: /demo|remov|tear\s*out|take\s*down|ripped?|damaged|haul/i,
        unitsPerHour: 50,
        hardAccessMult: 1.25,
      },
      {
        id: 'hang',
        label: 'Hang / screw board',
        // Default phase for any drywall job unless description is clearly finish-only
        detect:
          /hang|install|new\s*drywall|replace|board|sheetrock|gypsum|drywall|ceiling|wall(?!\s*paint)/i,
        unitsPerHour: 32,
        hardAccessMult: 1.35,
      },
      {
        id: 'finish',
        label: 'Tape, mud, sand, finish',
        detect:
          /tape|mud|finish|sand|texture|skim|float|3\s*coat|three\s*coat|level\s*[45]|hang|install|drywall|sheetrock/i,
        unitsPerHour: 20,
        hardAccessMult: 1.2,
      },
      {
        id: 'paint',
        label: 'Prime & paint',
        detect: /paint|primer|prime\b|recoat/i,
        unitsPerHour: 110,
        hardAccessMult: 1.15,
      },
    ],
  },
  // ——— Paint (only when not primarily drywall) ———
  {
    id: 'paint',
    label: 'Painting',
    detect: /paint|painting|primer|stain(?:ing)?\s+(?:the\s+)?(?:wall|interior|exterior|trim)/i,
    exclude: /drywall|sheetrock|hang\s*rock|\bmud\b|tape\s*(?:and|&)?\s*mud/i,
    measure: 'sqft',
    typicalRate: 58,
    maxRate: 75,
    minJobHours: 2,
    midInstalledPerUnit: 1.85,
    fallbackUnitsPerHour: 100,
    phases: [
      {
        id: 'prep',
        label: 'Prep / mask / sand',
        always: true,
        unitsPerHour: 180,
        fixedHours: 0.75,
      },
      {
        id: 'prime',
        label: 'Prime',
        detect: /primer|prime\b|seal/i,
        unitsPerHour: 160,
      },
      {
        id: 'paint',
        label: 'Paint coats',
        always: true,
        unitsPerHour: 100,
        hardAccessMult: 1.2,
      },
    ],
  },
  // ——— Roofing ———
  {
    id: 'roofing',
    label: 'Roofing',
    detect: /roof|shingle|re-?roof|underlayment|flashing/i,
    measure: 'sqft',
    typicalRate: 70,
    maxRate: 90,
    minJobHours: 4,
    midInstalledPerUnit: 5.5,
    fallbackUnitsPerHour: 35,
    phases: [
      {
        id: 'tearoff',
        label: 'Tear-off',
        detect: /tear|demo|remov|strip/i,
        always: true,
        unitsPerHour: 80,
        hardAccessMult: 1.3,
      },
      {
        id: 'deck_repair',
        label: 'Deck repair',
        detect: /deck|sheathing|osb|rot/i,
        unitsPerHour: 40,
      },
      {
        id: 'install',
        label: 'Underlayment + shingles',
        always: true,
        unitsPerHour: 45,
        hardAccessMult: 1.25,
      },
    ],
  },
  // ——— Flooring ———
  {
    id: 'flooring',
    label: 'Flooring',
    detect: /floor|lvp|laminate|hardwood|vinyl\s*plank|carpet|tile\s*floor|ceramic|porcelain/i,
    exclude: /roof|ceiling\s*tile/i,
    measure: 'sqft',
    typicalRate: 65,
    maxRate: 85,
    minJobHours: 3,
    midInstalledPerUnit: 4.5,
    fallbackUnitsPerHour: 22,
    phases: [
      {
        id: 'demo',
        label: 'Pull existing floor',
        detect: /demo|remov|tear|pull\s*up|rip\s*up/i,
        unitsPerHour: 35,
      },
      {
        id: 'prep',
        label: 'Subfloor / underlayment',
        always: true,
        unitsPerHour: 50,
        fixedHours: 0.5,
      },
      {
        id: 'install',
        label: 'Install flooring',
        always: true,
        unitsPerHour: 22,
      },
      {
        id: 'trim',
        label: 'Transitions / base',
        detect: /base|trim|transition|quarter\s*round/i,
        unitsPerHour: 40,
        fixedHours: 0.5,
      },
    ],
  },
  // ——— Siding / exterior ———
  {
    id: 'siding',
    label: 'Siding / exterior cladding',
    detect: /siding|soffit|fascia|hardie|cement\s*board\s*siding|vinyl\s*siding/i,
    measure: 'sqft',
    typicalRate: 68,
    maxRate: 88,
    minJobHours: 4,
    midInstalledPerUnit: 6,
    fallbackUnitsPerHour: 20,
    phases: [
      {
        id: 'demo',
        label: 'Remove old siding',
        detect: /demo|remov|tear|replace/i,
        unitsPerHour: 45,
      },
      {
        id: 'wrap',
        label: 'House wrap / flash',
        detect: /wrap|tyvek|flash|weather/i,
        unitsPerHour: 60,
      },
      {
        id: 'install',
        label: 'Install siding',
        always: true,
        unitsPerHour: 22,
        hardAccessMult: 1.3,
      },
    ],
  },
  // ——— Insulation ———
  {
    id: 'insulation',
    label: 'Insulation',
    detect: /insulat|batt|blown[\s-]?in|spray\s*foam|r-?\s*\d{1,2}/i,
    measure: 'sqft',
    typicalRate: 58,
    maxRate: 75,
    minJobHours: 2,
    midInstalledPerUnit: 2.2,
    fallbackUnitsPerHour: 50,
    phases: [
      {
        id: 'install',
        label: 'Install insulation',
        always: true,
        unitsPerHour: 45,
        hardAccessMult: 1.2,
      },
    ],
  },
  // ——— Concrete / flatwork ———
  {
    id: 'concrete',
    label: 'Concrete / flatwork',
    detect: /concrete|flatwork|sidewalk|driveway|patio\s*slab|foundation\s*repair|stamped/i,
    measure: 'sqft',
    typicalRate: 68,
    maxRate: 90,
    minJobHours: 4,
    midInstalledPerUnit: 9,
    fallbackUnitsPerHour: 25,
    phases: [
      {
        id: 'demo',
        label: 'Demo / excavate',
        detect: /demo|remov|excavat|break\s*out/i,
        unitsPerHour: 30,
      },
      {
        id: 'form',
        label: 'Form & base',
        always: true,
        unitsPerHour: 35,
        fixedHours: 1,
      },
      {
        id: 'pour',
        label: 'Pour & finish',
        always: true,
        unitsPerHour: 40,
        fixedHours: 1,
      },
    ],
  },
  // ——— Fencing (linear) ———
  {
    id: 'fencing',
    label: 'Fencing',
    detect: /fence|fencing|picket|privacy\s*fence|chain\s*link/i,
    measure: 'lf',
    typicalRate: 60,
    maxRate: 80,
    minJobHours: 3,
    midInstalledPerUnit: 35,
    fallbackUnitsPerHour: 8,
    phases: [
      {
        id: 'demo',
        label: 'Remove old fence',
        detect: /demo|remov|replace|tear/i,
        unitsPerHour: 15,
      },
      {
        id: 'posts',
        label: 'Set posts',
        always: true,
        unitsPerHour: 6,
        fixedHours: 1,
      },
      {
        id: 'panels',
        label: 'Hang panels / pickets',
        always: true,
        unitsPerHour: 12,
      },
    ],
  },
  // ——— Gutters (linear) ———
  {
    id: 'gutters',
    label: 'Gutters',
    detect: /gutter|downspout/i,
    exclude: /clean(?:ing)?\s+gutter/i,
    measure: 'lf',
    typicalRate: 62,
    maxRate: 80,
    minJobHours: 2,
    midInstalledPerUnit: 12,
    fallbackUnitsPerHour: 14,
    phases: [
      {
        id: 'demo',
        label: 'Remove old gutters',
        detect: /demo|remov|replace/i,
        unitsPerHour: 25,
      },
      {
        id: 'install',
        label: 'Install gutters / downspouts',
        always: true,
        unitsPerHour: 14,
        hardAccessMult: 1.25,
        fixedHours: 0.75,
      },
    ],
  },
  // ——— Decking ———
  {
    id: 'decking',
    label: 'Deck build / repair',
    detect: /deck(?!\s*screw)|composite\s*deck|decking/i,
    measure: 'sqft',
    typicalRate: 65,
    maxRate: 85,
    minJobHours: 4,
    midInstalledPerUnit: 28,
    fallbackUnitsPerHour: 12,
    phases: [
      {
        id: 'demo',
        label: 'Demo old deck',
        detect: /demo|remov|tear|rebuild/i,
        unitsPerHour: 20,
      },
      {
        id: 'frame',
        label: 'Frame',
        detect: /frame|joist|beam|post|build|new\s*deck/i,
        always: true,
        unitsPerHour: 10,
        fixedHours: 2,
      },
      {
        id: 'decking',
        label: 'Decking boards',
        always: true,
        unitsPerHour: 18,
      },
      {
        id: 'rail',
        label: 'Railings',
        detect: /rail|baluster|guard/i,
        unitsPerHour: 8,
        fixedHours: 1,
      },
    ],
  },
  // ——— Electrical (mostly unit; area for rewire approx) ———
  {
    id: 'electrical',
    label: 'Electrical',
    detect: /electrical|electrician|wiring|outlet|receptacle|switch|gfci|panel|breaker|circuit|light\s*fixture|ceiling\s*fan|romex/i,
    exclude: /plumb|toilet|faucet/i,
    measure: 'ea',
    typicalRate: 78,
    maxRate: 98,
    minJobHours: 1,
    fallbackUnitsPerHour: 1,
    phases: [
      {
        id: 'device',
        label: 'Device / fixture work',
        always: true,
        unitsPerHour: 0.55, // ~1.8 hrs per device average (will use unit tasks for simple)
        fixedHours: 0.5,
      },
    ],
  },
  // ——— Plumbing ———
  {
    id: 'plumbing',
    label: 'Plumbing',
    detect: /plumb|toilet|faucet|drain|pipe|water\s*heater|disposal|shower\s*valve|supply\s*line|pex|shut.?off/i,
    measure: 'ea',
    typicalRate: 80,
    maxRate: 100,
    minJobHours: 1,
    fallbackUnitsPerHour: 1,
    phases: [
      {
        id: 'fixture',
        label: 'Fixture / repair work',
        always: true,
        unitsPerHour: 0.4,
        fixedHours: 0.5,
      },
    ],
  },
  // ——— HVAC ———
  {
    id: 'hvac',
    label: 'HVAC',
    detect: /hvac|furnace|air\s*condition|a\/c\b|ac\s*unit|heat\s*pump|duct|thermostat|condenser/i,
    measure: 'ea',
    typicalRate: 88,
    maxRate: 110,
    minJobHours: 2,
    fallbackUnitsPerHour: 1,
    phases: [
      {
        id: 'service',
        label: 'HVAC service / install',
        always: true,
        unitsPerHour: 0.2,
        fixedHours: 1.5,
      },
    ],
  },
  // ——— Carpentry / doors / trim ———
  {
    id: 'carpentry',
    label: 'Carpentry / doors / trim',
    detect: /door|trim|baseboard|casing|cabinet|carpenter|framing|window(?!\s*ac)/i,
    exclude: /garage\s*door\s*opener|screen\s*door\s*only/i,
    measure: 'ea',
    typicalRate: 62,
    maxRate: 82,
    minJobHours: 1.5,
    fallbackUnitsPerHour: 1,
    phases: [
      {
        id: 'install',
        label: 'Install / fit',
        always: true,
        unitsPerHour: 0.35,
        fixedHours: 0.75,
      },
    ],
  },
  // ——— Landscaping ———
  {
    id: 'landscaping',
    label: 'Landscaping',
    detect: /landscap|mulch|sod|irrigation|sprinkler|tree\s*remov|grading|retaining\s*wall|paver/i,
    measure: 'sqft',
    typicalRate: 55,
    maxRate: 75,
    minJobHours: 2,
    midInstalledPerUnit: 3.5,
    fallbackUnitsPerHour: 40,
    phases: [
      {
        id: 'prep',
        label: 'Site prep',
        always: true,
        unitsPerHour: 60,
        fixedHours: 1,
      },
      {
        id: 'install',
        label: 'Install hardscape / plantings',
        always: true,
        unitsPerHour: 35,
      },
    ],
  },
];

function parseLf(description: string, suggestedQty: number, unit: string): number | null {
  const text = description.toLowerCase();
  const m = text.match(/(\d[\d,]*)\s*(?:lf|lin(?:ear)?\s*f(?:ee)?t|l\.?f\.?)\b/i);
  if (m) {
    const n = Number(m[1].replace(/,/g, ''));
    if (n > 0) return n;
  }
  if (suggestedQty > 1 && /lf|lin|ft|feet/i.test(unit)) return suggestedQty;
  if (suggestedQty >= 10 && /fence|gutter|baseboard|trim/i.test(text)) return suggestedQty;
  return null;
}

function isHardAccess(description: string): boolean {
  return /ceiling|overhead|second\s*st|2nd\s*st|ladder|scaffold|crawl|attic|steep|high\s*wall/i.test(
    description
  );
}

function pickQuantity(
  industry: IndustryDef,
  description: string,
  suggestedQty: number,
  unit: string
): number {
  if (industry.measure === 'sqft') {
    const sq = parseSqftFromDescription(description);
    if (sq && sq > 0) return sq;
    if (suggestedQty > 1 && /sf|sqft|sq\.?\s*ft|square/i.test(unit)) return suggestedQty;
    if (suggestedQty >= 20) return suggestedQty;
    return Math.max(1, suggestedQty || 1);
  }
  if (industry.measure === 'lf') {
    return parseLf(description, suggestedQty, unit) || Math.max(1, suggestedQty || 1);
  }
  // ea / job
  return Math.max(1, suggestedQty > 0 && suggestedQty < 50 ? suggestedQty : 1);
}

function phaseApplies(phase: PhaseDef, description: string): boolean {
  if (phase.always) return true;
  if (phase.detect) return phase.detect.test(description);
  return false;
}

/**
 * Estimate labor for any detected industry using phase production rates.
 * Returns null if no industry rule matches (caller falls back to unit tasks).
 */
export function estimateIndustryLabor(
  description: string,
  suggestedQty = 1,
  unit = ''
): IndustryLaborResult | null {
  const text = description || '';
  const hard = isHardAccess(text);

  for (const industry of INDUSTRIES) {
    if (!industry.detect.test(text)) continue;
    if (industry.exclude && industry.exclude.test(text)) continue;

    const quantity = pickQuantity(industry, text, suggestedQty, unit);
    const phases: IndustryLaborResult['phases'] = [];
    let totalHours = 0;

    for (const phase of industry.phases) {
      if (!phaseApplies(phase, text)) continue;
      let hours = 0;
      if (phase.fixedHours) hours += phase.fixedHours;
      if (phase.unitsPerHour > 0 && quantity > 0) {
        hours += quantity / phase.unitsPerHour;
      }
      if (hard && phase.hardAccessMult) {
        hours *= phase.hardAccessMult;
      }
      if (hours > 0.05) {
        phases.push({ id: phase.id, label: phase.label, hours: roundMoney(hours) });
        totalHours += hours;
      }
    }

    if (totalHours <= 0) {
      totalHours = quantity / Math.max(0.1, industry.fallbackUnitsPerHour);
      phases.push({
        id: 'general',
        label: `${industry.label} work`,
        hours: roundMoney(totalHours),
      });
    }

    // Mobilization / setup / cleanup for any real job
    const mob = quantity >= 50 || industry.measure === 'job' ? 1.0 : 0.5;
    totalHours += mob;
    phases.push({ id: 'mob', label: 'Mobilize / cleanup', hours: mob });

    const expected = Math.max(industry.minJobHours, totalHours);
    return {
      tradeId: industry.id,
      tradeLabel: industry.label,
      measure: industry.measure,
      quantity,
      minHours: roundMoney(expected * 0.78),
      expectedHours: roundMoney(expected),
      maxHours: roundMoney(expected * 1.4),
      typicalRate: industry.typicalRate,
      maxRate: industry.maxRate,
      phases,
      notes: `${industry.label}: ${phases
        .filter((p) => p.id !== 'mob')
        .map((p) => p.label)
        .join(' + ')} on ${quantity} ${industry.measure}`,
    };
  }

  return null;
}

/** Prompt block so the AI doesn't invent fantasy production rates */
export function formatIndustryLaborPrompt(): string {
  return `LABOR AUTHORITY (do not invent superhuman production rates):
A server-side industry engine will recalculate crew-hours from real trade production rates.
Your laborBreakdown.hours should be conservative/realistic. When unsure, OVER-estimate hours slightly rather than under.
Phase thinking by trade (examples):
- Drywall: demo + hang + tape/mud/sand + optional paint — ceiling slower; 200 SF full replace is often 14–22 crew-hrs, never 1–3.
- Paint-only: prep + prime + coats — not the same as drywall finish.
- Roofing: tear-off + underlayment + shingles by squares.
- Flooring: demo + prep + install + transitions.
- Electrical/plumbing fixtures: use typical 1–4 hrs per simple device; panels and rewires much more.
Always set laborBreakdown.hours = TOTAL crew-hours for the FULL scope, rate = mid local trade rate, total = hours × rate (for Unit jobs) or full-job labor $ (for SF, still full-job hours).`;
}
