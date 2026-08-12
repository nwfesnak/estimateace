/**
 * Mid-grade Lowe's.com-style shelf prices for contractor estimating.
 *
 * These are national mid-grade / good-better retail ranges (not clearance,
 * not luxury brand, not contractor-only bulk). Applied after the AI suggests
 * materials so unit prices stay realistic for what a homeowner would pay at Lowe's.
 *
 * Regional multipliers from ai-quote-region still apply on top of these basess.
 *
 * Sources: typical Lowe's mid-tier SKUs (Good/Better), 2025–2026 market levels.
 * Not a live scrape — refresh periodically. Live Lowe's cart prices vary by store.
 */

export type LowesPriceGuide = {
  /** Match material description */
  pattern: RegExp;
  /** Optional match on unit (sqft, gallon, ea, …) */
  unitPattern?: RegExp;
  /** Typical Lowe's shelf unit price (national mid) */
  typical: number;
  /** Floor — below this is unrealistically cheap for Lowe's mid-grade */
  min: number;
  /** Ceiling — above this is luxury/pro specialty, not mid-grade shelf */
  max: number;
  /** Human label for prompts */
  label: string;
  unitHint: string;
};

const roundMoney = (n: number) => Math.round(n * 100) / 100;

/**
 * Ordered most-specific first where patterns could overlap.
 */
export const LOWES_MATERIAL_PRICE_GUIDE: LowesPriceGuide[] = [
  // --- Lumber & sheets ---
  { pattern: /\b2\s*x\s*4\b|2x4.*stud|stud.*2x4/i, unitPattern: /ea|pc|piece|each/i, typical: 4.28, min: 3.2, max: 7.5, label: '2x4x8 stud', unitHint: 'ea' },
  { pattern: /\b2\s*x\s*6\b|2x6/i, unitPattern: /ea|pc|piece|each/i, typical: 7.48, min: 5.5, max: 12, label: '2x6 stud/board', unitHint: 'ea' },
  { pattern: /pressure\s*treat|pt\s*2x|ground\s*contact/i, unitPattern: /ea|pc|lf/i, typical: 9.98, min: 6, max: 18, label: 'Pressure-treated lumber', unitHint: 'ea' },
  { pattern: /plywood|cdx/i, unitPattern: /sheet|ea|each/i, typical: 42.98, min: 28, max: 72, label: 'Plywood sheet', unitHint: 'sheet' },
  { pattern: /\bosb\b|oriented\s*strand|sheathing/i, unitPattern: /sheet|ea|each/i, typical: 28.98, min: 18, max: 48, label: 'OSB sheathing', unitHint: 'sheet' },
  { pattern: /drywall|sheetrock|gypsum\s*board/i, unitPattern: /sheet|ea|each/i, typical: 14.98, min: 10, max: 24, label: '1/2" drywall 4x8', unitHint: 'sheet' },
  { pattern: /cement\s*board|durock|hardiebacker|backer\s*board/i, unitPattern: /sheet|ea|each/i, typical: 16.98, min: 11, max: 28, label: 'Cement backer board', unitHint: 'sheet' },

  // --- Paint & coatings ---
  { pattern: /interior.*(paint|latex)|latex.*interior|wall\s*paint|ceiling\s*paint/i, unitPattern: /gal|gallon/i, typical: 34.98, min: 22, max: 52, label: 'Interior latex paint (gal)', unitHint: 'gallon' },
  { pattern: /exterior.*(paint|latex)|latex.*exterior/i, unitPattern: /gal|gallon/i, typical: 42.98, min: 28, max: 62, label: 'Exterior paint (gal)', unitHint: 'gallon' },
  { pattern: /primer|kilz|zinsser/i, unitPattern: /gal|gallon/i, typical: 26.98, min: 16, max: 42, label: 'Primer (gal)', unitHint: 'gallon' },
  { pattern: /paint|latex/i, unitPattern: /gal|gallon/i, typical: 34.98, min: 20, max: 55, label: 'Paint (gal)', unitHint: 'gallon' },
  { pattern: /caulk|sealant|silicone/i, unitPattern: /tube|ea|each/i, typical: 6.48, min: 3.5, max: 14, label: 'Caulk tube', unitHint: 'ea' },

  // --- Flooring ---
  { pattern: /lvp|luxury\s*vinyl|vinyl\s*plank|rigid\s*core/i, unitPattern: /sqft|sq\s*ft|sf/i, typical: 2.79, min: 1.49, max: 5.5, label: 'LVP flooring', unitHint: 'sqft' },
  { pattern: /laminate\s*floor/i, unitPattern: /sqft|sq\s*ft|sf/i, typical: 2.29, min: 1.29, max: 4.5, label: 'Laminate flooring', unitHint: 'sqft' },
  { pattern: /hardwood|engineered\s*wood|oak\s*floor/i, unitPattern: /sqft|sq\s*ft|sf/i, typical: 4.98, min: 2.99, max: 9.5, label: 'Hardwood/engineered floor', unitHint: 'sqft' },
  { pattern: /ceramic\s*tile|porcelain\s*tile|floor\s*tile|wall\s*tile|\btile\b/i, unitPattern: /sqft|sq\s*ft|sf/i, typical: 2.98, min: 1.29, max: 8, label: 'Ceramic/porcelain tile', unitHint: 'sqft' },
  { pattern: /carpet/i, unitPattern: /sqft|sq\s*ft|sf|sq\s*yd|sy/i, typical: 2.49, min: 1.2, max: 6, label: 'Carpet', unitHint: 'sqft' },
  { pattern: /underlayment|underlay/i, unitPattern: /sqft|sq\s*ft|sf|roll/i, typical: 0.55, min: 0.25, max: 1.5, label: 'Floor underlayment', unitHint: 'sqft' },
  { pattern: /thinset|mortar\s*mix|tile\s*mortar/i, unitPattern: /bag|ea/i, typical: 18.98, min: 10, max: 35, label: 'Thinset bag', unitHint: 'bag' },
  { pattern: /grout/i, unitPattern: /bag|lb|ea/i, typical: 16.98, min: 8, max: 32, label: 'Grout', unitHint: 'bag' },

  // --- Roofing ---
  { pattern: /architectural\s*shingle|dimensional\s*shingle|shingle/i, unitPattern: /bundle|bndl/i, typical: 36.98, min: 24, max: 55, label: 'Architectural shingles (bundle)', unitHint: 'bundle' },
  { pattern: /shingle|roofing/i, unitPattern: /square|sq\b/i, typical: 110, min: 75, max: 165, label: 'Shingles per square', unitHint: 'square' },
  { pattern: /roofing\s*felt|underlayment|synthetic\s*under/i, unitPattern: /roll|sq|square/i, typical: 89.0, min: 45, max: 160, label: 'Roof underlayment roll', unitHint: 'roll' },
  { pattern: /drip\s*edge|ridge\s*cap|flashing|step\s*flash/i, unitPattern: /ea|pc|lf|piece/i, typical: 12.98, min: 5, max: 45, label: 'Roof metal/flashing', unitHint: 'ea' },
  { pattern: /ice\s*&\s*water|ice\s*and\s*water|grace/i, unitPattern: /roll|sq/i, typical: 78.0, min: 45, max: 130, label: 'Ice & water shield', unitHint: 'roll' },

  // --- Concrete / masonry ---
  { pattern: /concrete\s*mix|sakrete|quikrete/i, unitPattern: /bag/i, typical: 6.48, min: 4.5, max: 14, label: 'Concrete mix 80lb', unitHint: 'bag' },
  { pattern: /mortar\s*mix/i, unitPattern: /bag/i, typical: 8.98, min: 5.5, max: 16, label: 'Mortar mix bag', unitHint: 'bag' },
  { pattern: /concrete\s*block|cinder\s*block|cmu/i, unitPattern: /ea|each/i, typical: 2.48, min: 1.5, max: 5, label: 'CMU block', unitHint: 'ea' },

  // --- Insulation ---
  { pattern: /fiberglass\s*bat|r-?\s*13|r-?\s*15|batt\s*insul/i, unitPattern: /bag|pack|bundle|ea/i, typical: 48.98, min: 28, max: 85, label: 'Fiberglass batt bag', unitHint: 'bag' },
  { pattern: /r-?\s*19|r-?\s*21|r-?\s*30|r-?\s*38|insulation/i, unitPattern: /bag|roll|bundle/i, typical: 58.0, min: 32, max: 120, label: 'Insulation bag/roll', unitHint: 'bag' },
  { pattern: /spray\s*foam|great\s*stuff/i, unitPattern: /can|ea|each/i, typical: 8.98, min: 4.5, max: 22, label: 'Spray foam can', unitHint: 'ea' },

  // --- Plumbing ---
  { pattern: /toilet/i, unitPattern: /ea|each/i, typical: 198.0, min: 99, max: 380, label: '2-piece toilet', unitHint: 'ea' },
  { pattern: /kitchen\s*faucet|pull.?down\s*faucet/i, unitPattern: /ea|each/i, typical: 149.0, min: 79, max: 320, label: 'Kitchen faucet', unitHint: 'ea' },
  { pattern: /bath(room)?\s*faucet|lavatory\s*faucet|centerset|widespread/i, unitPattern: /ea|each/i, typical: 79.0, min: 39, max: 220, label: 'Bath faucet', unitHint: 'ea' },
  { pattern: /faucet/i, unitPattern: /ea|each/i, typical: 98.0, min: 45, max: 250, label: 'Faucet', unitHint: 'ea' },
  { pattern: /garbage\s*disposal|food\s*waste|insinkerator|waste\s*king/i, unitPattern: /ea|each/i, typical: 149.0, min: 89, max: 320, label: 'Garbage disposal', unitHint: 'ea' },
  { pattern: /water\s*heater|tank\s*heater/i, unitPattern: /ea|each/i, typical: 579.0, min: 380, max: 1200, label: 'Tank water heater', unitHint: 'ea' },
  { pattern: /pex|cpvc|pvc\s*pipe|copper\s*pipe|\bpipe\b/i, unitPattern: /lf|ln\s*ft|ft|linear/i, typical: 1.28, min: 0.45, max: 8, label: 'Pipe (lf)', unitHint: 'lf' },
  // Repair kits / short section priced as an assembly (not $1/ea)
  {
    pattern: /water\s*line|pipe\s*(?:repair|section|replac)|repair\s*coupling|coupling|sharkbite|push[\s-]?fit/i,
    unitPattern: /ea|each|kit|set|lot/i,
    typical: 28.0,
    min: 12,
    max: 85,
    label: 'Pipe repair parts / couplings kit',
    unitHint: 'ea',
  },
  { pattern: /shut.?off\s*valve|angle\s*stop|supply\s*line|wax\s*ring|toilet\s*flange/i, unitPattern: /ea|each|kit/i, typical: 12.98, min: 4, max: 45, label: 'Plumbing fitting/part', unitHint: 'ea' },
  { pattern: /vanity/i, unitPattern: /ea|each/i, typical: 349.0, min: 149, max: 750, label: 'Bathroom vanity', unitHint: 'ea' },
  { pattern: /sink|basin|lavatory/i, unitPattern: /ea|each/i, typical: 98.0, min: 45, max: 280, label: 'Sink', unitHint: 'ea' },

  // --- Electrical ---
  { pattern: /gfci|gfi\s*outlet/i, unitPattern: /ea|each/i, typical: 18.98, min: 12, max: 35, label: 'GFCI outlet', unitHint: 'ea' },
  { pattern: /outlet|receptacle|duplex/i, unitPattern: /ea|each/i, typical: 2.48, min: 0.99, max: 12, label: 'Outlet', unitHint: 'ea' },
  { pattern: /light\s*switch|dimmer|3-?way\s*switch|\bswitch\b/i, unitPattern: /ea|each/i, typical: 3.48, min: 1.2, max: 28, label: 'Switch', unitHint: 'ea' },
  { pattern: /romex|nm-?b|12\/2|14\/2|electrical\s*wire|\bwire\b/i, unitPattern: /lf|ft|roll/i, typical: 0.89, min: 0.35, max: 2.5, label: 'NM-B wire (lf)', unitHint: 'lf' },
  { pattern: /ceiling\s*fan/i, unitPattern: /ea|each/i, typical: 129.0, min: 59, max: 320, label: 'Ceiling fan', unitHint: 'ea' },
  { pattern: /light\s*fixture|flush\s*mount|chandelier|vanity\s*light|recessed/i, unitPattern: /ea|each/i, typical: 48.0, min: 18, max: 180, label: 'Light fixture', unitHint: 'ea' },
  { pattern: /breaker|circuit\s*breaker/i, unitPattern: /ea|each/i, typical: 12.98, min: 6, max: 45, label: 'Circuit breaker', unitHint: 'ea' },
  { pattern: /electrical\s*box|junction\s*box|old\s*work\s*box/i, unitPattern: /ea|each/i, typical: 3.28, min: 1.2, max: 12, label: 'Electrical box', unitHint: 'ea' },

  // --- Doors & windows ---
  { pattern: /screen\s*door\s*handle|storm\s*door\s*handle|door\s*handle|lever\s*set|lockset|passage\s*set|privacy\s*set|deadbolt/i, unitPattern: /ea|each|kit|set/i, typical: 48.0, min: 18, max: 120, label: 'Door hardware', unitHint: 'ea' },
  { pattern: /interior\s*door|prehung\s*door|hollow\s*core/i, unitPattern: /ea|each/i, typical: 148.0, min: 79, max: 280, label: 'Interior prehung door', unitHint: 'ea' },
  { pattern: /exterior\s*door|entry\s*door|steel\s*door|fiberglass\s*door/i, unitPattern: /ea|each/i, typical: 398.0, min: 220, max: 900, label: 'Exterior entry door', unitHint: 'ea' },
  { pattern: /storm\s*door|screen\s*door/i, unitPattern: /ea|each/i, typical: 249.0, min: 129, max: 520, label: 'Storm/screen door', unitHint: 'ea' },
  { pattern: /window/i, unitPattern: /ea|each/i, typical: 289.0, min: 149, max: 650, label: 'Replacement window', unitHint: 'ea' },
  { pattern: /hinge/i, unitPattern: /ea|each|pair/i, typical: 6.98, min: 2.5, max: 22, label: 'Door hinge', unitHint: 'ea' },

  // --- Siding / exterior ---
  { pattern: /vinyl\s*siding|siding\s*panel/i, unitPattern: /sqft|sq\s*ft|sf|pc|piece|ea/i, typical: 2.49, min: 1.2, max: 6, label: 'Vinyl siding', unitHint: 'sqft' },
  { pattern: /house\s*wrap|tyvek|weather\s*barrier/i, unitPattern: /roll|sqft|sf/i, typical: 165.0, min: 90, max: 280, label: 'House wrap roll', unitHint: 'roll' },
  { pattern: /gutter/i, unitPattern: /lf|ft|section|ea/i, typical: 6.98, min: 3, max: 18, label: 'Gutter section', unitHint: 'lf' },
  { pattern: /downspout/i, unitPattern: /lf|ea|section/i, typical: 8.98, min: 4, max: 22, label: 'Downspout', unitHint: 'ea' },

  // --- Decking / fence ---
  { pattern: /composite\s*deck|trex|timbertech|deck\s*board/i, unitPattern: /lf|ea|pc/i, typical: 8.98, min: 4.5, max: 18, label: 'Composite deck board', unitHint: 'lf' },
  { pattern: /deck\s*screw|structural\s*screw/i, unitPattern: /box|lb|ea/i, typical: 28.0, min: 12, max: 55, label: 'Deck screws box', unitHint: 'box' },
  { pattern: /fence\s*panel|picket\s*panel/i, unitPattern: /ea|panel|section/i, typical: 58.0, min: 32, max: 120, label: 'Fence panel', unitHint: 'panel' },
  { pattern: /fence\s*post|4x4\s*post/i, unitPattern: /ea|each/i, typical: 18.98, min: 10, max: 45, label: 'Fence post', unitHint: 'ea' },

  // --- Misc consumables (group lines) ---
  { pattern: /fastener|screw|nail|misc\.?\s*supply|supplies|tape|mesh|corner\s*bead/i, unitPattern: /lot|box|ea|pack/i, typical: 24.0, min: 8, max: 75, label: 'Misc fasteners/supplies', unitHint: 'lot' },
  { pattern: /drop\s*cloth|painter.?s\s*tape|roller|brush|tray/i, unitPattern: /ea|lot|pack|set/i, typical: 12.98, min: 4, max: 40, label: 'Paint supplies', unitHint: 'lot' },
  { pattern: /mulch/i, unitPattern: /bag|cu\s*yd|yard/i, typical: 4.28, min: 2.5, max: 45, label: 'Mulch bag', unitHint: 'bag' },
  { pattern: /topsoil|garden\s*soil/i, unitPattern: /bag|cu\s*yd|yard/i, typical: 3.98, min: 2, max: 55, label: 'Topsoil bag', unitHint: 'bag' },
];

export type MarketMaterialLine = {
  description: string;
  qty: number;
  unit: string;
  unitPrice: number;
  total: number;
};

export function findLowesPriceGuide(
  description: string,
  unit: string
): LowesPriceGuide | null {
  const u = (unit || '').toLowerCase();
  for (const entry of LOWES_MATERIAL_PRICE_GUIDE) {
    if (!entry.pattern.test(description || '')) continue;
    if (entry.unitPattern && u && !entry.unitPattern.test(u)) {
      // Allow match without unit if unit is empty/generic
      if (u && !/^(ea|each|unit|lot|item)?$/i.test(u)) continue;
    }
    return entry;
  }
  return null;
}

/**
 * Force material unit prices onto Lowe's mid-grade shelf levels when we
 * recognize the product. Quantities stay as the AI estimated.
 */
export function applyLowesMaterialPrices<T extends MarketMaterialLine>(
  materials: T[],
  materialMultiplier = 1
): T[] {
  return materials.map((m) => {
    const guide = findLowesPriceGuide(m.description, m.unit);
    if (!guide) {
      // Unrecognized: light clamp only if wildly high
      if (m.unitPrice > 5000) {
        return {
          ...m,
          unitPrice: roundMoney(m.unitPrice * 0.5),
          total: roundMoney(m.qty * m.unitPrice * 0.5),
        } as T;
      }
      return {
        ...m,
        total: roundMoney((Number(m.qty) || 0) * (Number(m.unitPrice) || 0)),
      } as T;
    }

    const min = roundMoney(guide.min * materialMultiplier);
    const max = roundMoney(guide.max * materialMultiplier);
    const typical = roundMoney(guide.typical * materialMultiplier);
    let unitPrice = Number(m.unitPrice) || 0;

    // Snap to Lowe's typical when AI is outside the realistic band or empty
    if (unitPrice <= 0 || unitPrice < min * 0.85 || unitPrice > max) {
      unitPrice = typical;
    } else if (unitPrice > typical * 1.35) {
      // Mild pull toward typical when high but under max
      unitPrice = roundMoney(unitPrice * 0.45 + typical * 0.55);
    } else if (unitPrice < typical * 0.7) {
      unitPrice = roundMoney(unitPrice * 0.4 + typical * 0.6);
    }

    unitPrice = Math.min(max, Math.max(min, unitPrice));
    const qty = Number(m.qty) || 0;
    return {
      ...m,
      unitPrice: roundMoney(unitPrice),
      total: roundMoney(qty * unitPrice),
    } as T;
  });
}

/** Compact table for the AI system prompt */
export function formatLowesPriceGuideForPrompt(): string {
  const lines = [
    "MATERIAL PRICING SOURCE — Lowe's.com mid-grade shelf (Good/Better, not clearance, not luxury):",
    'Use these unit prices as the PRIMARY material cost basis. Adjust ±10–20% only for local store variance.',
    'Do NOT invent luxury brand prices. Do NOT use contractor wholesale unless the description says so.',
    '',
  ];
  // Deduplicate by label for a readable prompt subset
  const seen = new Set<string>();
  for (const g of LOWES_MATERIAL_PRICE_GUIDE) {
    if (seen.has(g.label)) continue;
    seen.add(g.label);
    lines.push(
      `- ${g.label}: ~$${g.typical.toFixed(2)} per ${g.unitHint} (Lowe's mid; range $${g.min.toFixed(2)}–$${g.max.toFixed(2)})`
    );
    if (seen.size >= 45) break;
  }
  lines.push(
    '',
    "For any material not listed, price as a typical Lowe's.com mid-grade SKU a homeowner would buy today.",
    "materials[].unitPrice MUST reflect Lowe's shelf, not installed contractor markup (labor is separate)."
  );
  return lines.join('\n');
}
