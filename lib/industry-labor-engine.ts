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
  // ——— Paint (runs even with drywall when paint/match finish is in scope) ———
  {
    id: 'paint',
    label: 'Painting',
    detect:
      /paint|painting|primer|prime\b|matching\s*finish|uniform.*finish|recoat|touch[\s-]?up\s*paint/i,
    measure: 'sqft',
    typicalRate: 58,
    maxRate: 75,
    minJobHours: 2.5,
    // Mid-market installed interior ceiling/wall paint ~$1.75–$2.50/SF
    midInstalledPerUnit: 2.05,
    fallbackUnitsPerHour: 85,
    phases: [
      {
        id: 'prep',
        label: 'Prep / mask / cover / sand',
        always: true,
        unitsPerHour: 140,
        fixedHours: 1.0,
        hardAccessMult: 1.2,
      },
      {
        id: 'prime',
        label: 'Prime (esp. new drywall / patch)',
        detect: /primer|prime\b|seal|new\s*board|drywall|patch|repair/i,
        unitsPerHour: 120,
        hardAccessMult: 1.15,
      },
      {
        id: 'paint',
        label: 'Paint coats (match / uniform finish)',
        always: true,
        // Ceiling + color match often needs careful 2nd coat — slower than walls
        unitsPerHour: 85,
        hardAccessMult: 1.25,
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
    detect:
      /plumb|toilet|faucet|drain|pipe|water\s*line|water\s*heater|disposal|shower\s*valve|supply\s*line|pex|shut.?off|leak/i,
    measure: 'ea',
    typicalRate: 85,
    maxRate: 110,
    minJobHours: 1.5,
    fallbackUnitsPerHour: 1,
    phases: [
      {
        id: 'access_pipe',
        label: 'Access / cut-out pipe repair (ceiling or wall)',
        detect:
          /water\s*line|cut\s*out|replac(?:e|ing).{0,40}(?:pipe|line)|pipe\s*repair|stop\s*the\s*leak|section\s*of\s*(?:water|pipe)|access/i,
        // Real-world: shut off, drain, cut, fit, solder/crimp, test — not a 30-min swap
        fixedHours: 3.25,
        unitsPerHour: 0,
        hardAccessMult: 1.35,
      },
      {
        id: 'fixture',
        label: 'Fixture / standard plumbing',
        detect: /toilet|faucet|disposal|valve|shut.?off|supply/i,
        unitsPerHour: 0.4,
        fixedHours: 0.75,
      },
      {
        id: 'general_plumb',
        label: 'Plumbing work',
        // Fallback when only generic "plumb/pipe" matched
        detect: /plumb|pipe|leak|water/i,
        fixedHours: 2.0,
        unitsPerHour: 0,
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

/** Parse "10 ft × 30 ft", "4x4", "10' x 30'" style dimensions into areas (sqft). */
export function parseDimensionAreas(description: string): number[] {
  const areas: number[] = [];
  const re =
    /(\d+(?:\.\d+)?)\s*(?:ft|foot|feet|')?\s*[x×]\s*(\d+(?:\.\d+)?)\s*(?:ft|foot|feet|')?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(description || '')) !== null) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a > 0 && b > 0) areas.push(roundMoney(a * b));
  }
  return areas;
}

function isHardAccess(description: string): boolean {
  return /ceiling|overhead|second\s*st|2nd\s*st|ladder|scaffold|crawl|attic|steep|high\s*wall|access/i.test(
    description
  );
}

/**
 * Pick quantity for a trade when MULTIPLE scopes share one description.
 * Example: 4×4 access cut + paint 10×30 ceiling → drywall uses 16 SF, paint uses 300 SF.
 */
function pickQuantityForTrade(
  industry: IndustryDef,
  description: string,
  suggestedQty: number,
  unit: string
): number {
  const text = description || '';
  const areas = parseDimensionAreas(text);
  const parsedSqft = parseSqftFromDescription(text);

  if (industry.id === 'paint') {
    // Prefer largest area (full ceiling match paint), not the small patch
    let paintQty = 0;
    if (areas.length) paintQty = Math.max(...areas);
    else if (parsedSqft && parsedSqft >= 40) paintQty = parsedSqft;
    else if (suggestedQty >= 40) paintQty = suggestedQty;
    else paintQty = Math.max(parsedSqft || 0, suggestedQty || 0, 1);

    // Whole-home floor SF is NOT wall+ceiling area. Expand only for interior whole-home language.
    // Exterior + interior of an N sqft home ≈ ~2.8–3.5× floor for interior + exterior walls (not 20×).
    const wholeHome =
      /home|house|residence|ranch|whole|entire/i.test(text) && paintQty >= 400;
    const dual =
      /exterior\s*\/\s*interior|interior\s*\/\s*exterior|exterior\s*(?:and|&|\+)\s*interior|interior\s*(?:and|&|\+)\s*exterior/i.test(
        text
      );
    if (wholeHome && dual) {
      // Interior surfaces ~3.15× floor + exterior walls ~1.1× floor ≈ 4.25× (rough residential)
      paintQty = Math.round(paintQty * 4.25);
    } else if (wholeHome && /interior|inside/i.test(text) && !/exterior|outside/i.test(text)) {
      paintQty = Math.round(paintQty * 3.15);
    } else if (wholeHome && /exterior|outside/i.test(text) && !/interior|inside/i.test(text)) {
      paintQty = Math.round(paintQty * 1.35);
    }
    // Dual coat slows production but should not multiply area again (handled by phase rates)
    // Hard cap: never treat a residential home as > 25k SF of paint surface
    return Math.min(paintQty, 25000);
  }

  if (industry.id === 'drywall') {
    // Prefer small patch / access opening when paint also covers a large area
    const hasLargePaint =
      /paint|matching\s*finish|uniform/i.test(text) &&
      ((parsedSqft && parsedSqft >= 80) ||
        areas.some((a) => a >= 80) ||
        (suggestedQty >= 80 && /sf|sqft|sq/i.test(unit)));
    if (hasLargePaint && areas.length) {
      const small = Math.min(...areas.filter((a) => a > 0));
      if (small > 0 && small < 80) return small;
    }
    // Explicit patch language
    const patch = text.match(
      /(\d+(?:\.\d+)?)\s*(?:ft|')?\s*[x×]\s*(\d+(?:\.\d+)?)\s*(?:ft|')?.{0,40}(?:section|opening|patch|access|cut)/i
    );
    if (patch) {
      const a = Number(patch[1]) * Number(patch[2]);
      if (a > 0 && a < 200) return a;
    }
    if (areas.length && Math.min(...areas) < 50) return Math.min(...areas);
    if (parsedSqft && parsedSqft > 0 && parsedSqft < 80) return parsedSqft;
    // Full drywall area job
    if (parsedSqft) return parsedSqft;
    if (areas.length) return Math.max(...areas);
    if (suggestedQty > 1 && /sf|sqft/i.test(unit)) return suggestedQty;
    return Math.max(1, suggestedQty >= 10 ? suggestedQty : 16);
  }

  if (industry.measure === 'sqft') {
    if (parsedSqft && parsedSqft > 0) return parsedSqft;
    if (areas.length) return Math.max(...areas);
    if (suggestedQty > 1 && /sf|sqft|sq\.?\s*ft|square/i.test(unit)) return suggestedQty;
    if (suggestedQty >= 20) return suggestedQty;
    return Math.max(1, suggestedQty || 1);
  }
  if (industry.measure === 'lf') {
    return parseLf(description, suggestedQty, unit) || Math.max(1, suggestedQty || 1);
  }
  return Math.max(1, suggestedQty > 0 && suggestedQty < 50 ? suggestedQty : 1);
}

function phaseApplies(phase: PhaseDef, description: string): boolean {
  if (phase.always) return true;
  if (phase.detect) return phase.detect.test(description);
  return false;
}

function computeOneIndustry(
  industry: IndustryDef,
  description: string,
  suggestedQty: number,
  unit: string
): IndustryLaborResult | null {
  if (!industry.detect.test(description)) return null;
  if (industry.exclude && industry.exclude.test(description)) return null;

  const hard = isHardAccess(description);
  const quantity = pickQuantityForTrade(industry, description, suggestedQty, unit);
  const phases: IndustryLaborResult['phases'] = [];
  let totalHours = 0;
  const seenPhase = new Set<string>();

  for (const phase of industry.phases) {
    if (!phaseApplies(phase, description)) continue;
    // Avoid double-counting plumbing general + access
    if (industry.id === 'plumbing' && phase.id === 'general_plumb') {
      if (seenPhase.has('access_pipe') || seenPhase.has('fixture')) continue;
    }
    // When a large paint area is in scope, paint hours come from the paint trade only
    if (industry.id === 'drywall' && phase.id === 'paint') {
      const areas = parseDimensionAreas(description);
      const big =
        Math.max(
          ...(areas.length ? areas : [0]),
          parseSqftFromDescription(description) || 0,
          suggestedQty >= 80 ? suggestedQty : 0
        ) >= 80;
      if (big) continue;
    }
    let hours = 0;
    if (phase.fixedHours) hours += phase.fixedHours;
    if (phase.unitsPerHour > 0 && quantity > 0) {
      hours += quantity / phase.unitsPerHour;
    }
    if (hard && phase.hardAccessMult) {
      hours *= phase.hardAccessMult;
    }
    if (hours > 0.05) {
      seenPhase.add(phase.id);
      phases.push({
        id: `${industry.id}:${phase.id}`,
        label: `${industry.label}: ${phase.label}`,
        hours: roundMoney(hours),
      });
      totalHours += hours;
    }
  }

  if (totalHours <= 0) {
    totalHours = quantity / Math.max(0.1, industry.fallbackUnitsPerHour);
    phases.push({
      id: `${industry.id}:general`,
      label: `${industry.label} work`,
      hours: roundMoney(totalHours),
    });
  }

  const mob = quantity >= 80 || industry.measure === 'job' ? 0.75 : 0.4;
  totalHours += mob;
  phases.push({
    id: `${industry.id}:mob`,
    label: `${industry.label}: setup / cleanup`,
    hours: mob,
  });

  // Dual / multi-coat slows production slightly (do not re-multiply area)
  const coatMult = /three\s*coat|3\s*coat/i.test(description)
    ? 1.25
    : /two\s*coat|2\s*coat|dual[\s-]*coat|double[\s-]*coat/i.test(description)
      ? 1.15
      : 1;
  totalHours *= coatMult;

  // Residential paint absolute ceiling (crew-hours). A 1,200 SF home int+ext dual coat
  // is typically ~40–90 crew-hrs — never thousands.
  if (industry.id === 'paint') {
    const floorHint = parseSqftFromDescription(description) || 0;
    const homeCap =
      floorHint >= 400
        ? Math.min(100, Math.max(28, floorHint / 14))
        : quantity >= 2000
          ? Math.min(100, quantity / 55)
          : Math.min(80, quantity / 45 + 6);
    totalHours = Math.min(totalHours, homeCap);
  }

  const expected = Math.max(industry.minJobHours, totalHours);
  return {
    tradeId: industry.id,
    tradeLabel: industry.label,
    measure: industry.measure,
    quantity,
    minHours: roundMoney(expected * 0.8),
    expectedHours: roundMoney(expected),
    maxHours: roundMoney(Math.min(expected * 1.35, industry.id === 'paint' ? 180 : expected * 1.35)),
    typicalRate: industry.typicalRate,
    maxRate: industry.maxRate,
    phases,
    notes: `${industry.label} (${quantity} ${industry.measure})`,
  };
}

/**
 * Estimate labor across ALL matching trades (multi-scope jobs).
 * Example: water-line repair + drywall patch + paint 300 SF ceiling → sum of all three.
 */
export function estimateIndustryLabor(
  description: string,
  suggestedQty = 1,
  unit = ''
): IndustryLaborResult | null {
  const text = description || '';
  const parts: IndustryLaborResult[] = [];

  for (const industry of INDUSTRIES) {
    const one = computeOneIndustry(industry, text, suggestedQty, unit);
    if (one) parts.push(one);
  }

  if (parts.length === 0) return null;

  if (parts.length === 1) {
    return parts[0];
  }

  // Multi-trade: SUM hours; rate = hour-weighted average of trade rates
  let expectedHours = 0;
  let minHours = 0;
  let maxHours = 0;
  let rateWeight = 0;
  let maxRate = 0;
  const phases: IndustryLaborResult['phases'] = [];
  const labels: string[] = [];

  for (const p of parts) {
    expectedHours += p.expectedHours;
    minHours += p.minHours;
    maxHours += p.maxHours;
    rateWeight += p.typicalRate * p.expectedHours;
    maxRate = Math.max(maxRate, p.maxRate);
    phases.push(...p.phases);
    labels.push(p.notes);
  }

  const typicalRate = expectedHours > 0 ? roundMoney(rateWeight / expectedHours) : 65;

  // Shared job mobilization once (parts already include small per-trade setup)
  return {
    tradeId: 'multi',
    tradeLabel: parts.map((p) => p.tradeLabel).join(' + '),
    measure: 'job',
    quantity: Math.max(...parts.map((p) => p.quantity), suggestedQty || 1),
    minHours: roundMoney(minHours),
    expectedHours: roundMoney(expectedHours),
    maxHours: roundMoney(maxHours),
    typicalRate,
    maxRate: maxRate || typicalRate + 20,
    phases,
    notes: `Multi-trade job: ${labels.join(' | ')}`,
  };
}

/** Prompt block so the AI doesn't invent fantasy production rates */
export function formatIndustryLaborPrompt(): string {
  return `LABOR AUTHORITY (do not invent superhuman production rates):
A server-side industry engine recalculates crew-hours from real trade production rates and SUMS every trade in the description.
MULTI-SCOPE jobs (e.g. plumbing repair + drywall patch + paint full ceiling) must include hours for EACH scope — never quote only the patch.
Examples of realistic totals:
- Paint 300 SF ceiling for uniform match (prep+prime+2 coats): often 6–10 crew-hrs; installed paint alone often $500–$900+ in many markets.
- Ceiling water-line cut-out repair: typically 3–5+ hrs (not under 1 hr).
- Drywall access patch (e.g. 4×4) hang+tape+sand: typically 2.5–5 hrs.
- Combined leak access + patch + paint whole ceiling: often 12–20+ crew-hrs total.
When unsure, OVER-estimate hours slightly. laborBreakdown.hours = TOTAL crew-hours for the FULL multi-trade scope.`;
}
