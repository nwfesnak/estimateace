/**
 * BuildCalculator.io Pricing Search API
 * https://buildcalculator.io/api-docs/
 *
 * Free, no auth. 55k+ construction work items with labor/material/equipment.
 * Data is typically EUR / metric (m2). We convert to USD + US customary for quotes.
 */

const BASE = 'https://buildcalculator.io/api/v1';
const M2_TO_SF = 10.76391041671;
/** Fallback EUR→USD if env not set (approx mid-market). */
const DEFAULT_EUR_USD = Number(process.env.BUILDCALCULATOR_EUR_USD || '1.08') || 1.08;

export type BuildCalcHit = {
  rateCode: string;
  name: string;
  originalName: string;
  unit: string;
  rawUnit: string;
  currency: string;
  totalPerUnit: number;
  laborPerUnit: number;
  materialPerUnit: number;
  equipmentPerUnit: number;
  laborHoursTotal: number;
  laborHoursPerUnit: number;
  category: string;
  section: string;
  /** Converted for US estimates */
  totalPerSfUsd: number | null;
  laborPerSfUsd: number | null;
  materialPerSfUsd: number | null;
  hoursPerSf: number | null;
  score: number;
};

export type BuildCalcQuoteAnchor = {
  source: 'buildcalculator.io';
  query: string;
  currency: string;
  hits: BuildCalcHit[];
  /** Best match used for anchoring */
  best: BuildCalcHit | null;
  /** Suggested full-job total (USD) when we know area */
  suggestedJobTotalUsd: number | null;
  /** Suggested crew-hours for full job */
  suggestedLaborHours: number | null;
  /** $/SF floor or surface (USD) for installed work — after optional regional blend */
  suggestedPerSfUsd: number | null;
  /**
   * Raw BuildCalculator unit cost in USD per billing SF (home floor when whole-home paint),
   * BEFORE EstimationPro / regional multipliers. Use as the true base cost.
   */
  baseUnitCostUsd: number | null;
  /** Quantity for billing (floor SF when available) */
  billingQuantity: number | null;
  surfaceSf: number | null;
  floorSf: number | null;
  promptBlock: string;
};

function roundMoney(n: number) {
  return Math.round(Math.max(0, n) * 100) / 100;
}

function eurToUsd(eur: number): number {
  return roundMoney(eur * DEFAULT_EUR_USD);
}

function isAreaUnit(unit: string, rawUnit: string): boolean {
  const u = `${unit} ${rawUnit}`.toLowerCase();
  return /\bm2\b|\bm²\b|sq\.?\s*m|100\s*m2|м2/.test(u);
}

/** raw_unit "100 m2" → package size for labor hours */
function packageSizeFromRawUnit(rawUnit: string): number {
  const m = String(rawUnit || '').match(/(\d+(?:\.\d+)?)\s*m2/i);
  if (m) return Math.max(1, Number(m[1]) || 100);
  return 100;
}

function scoreHit(hit: any, query: string): number {
  const q = query.toLowerCase();
  const name = String(hit.original_name || hit.name || '').toLowerCase();
  const cat = String(hit.classification?.section || hit.classification?.department || '').toLowerCase();
  const blob = `${name} ${cat}`;
  let s = 0;
  if (/paint|painting|primer|coat/.test(q) && /paint|painting|finish|plaster|wall|emulsion/.test(blob)) s += 40;
  if (/exterior|outside/.test(q) && /exterior|outside|facade|façade/.test(blob)) s += 20;
  if (/interior|inside/.test(q) && /interior|inside|indoor|room|plaster|prefab/.test(blob)) s += 20;
  if (/drywall|sheetrock|plaster/.test(q) && /drywall|plaster|gypsum|sheetrock/.test(blob)) s += 35;
  if (/roof|shingle/.test(q) && /roof|shingle/.test(blob)) s += 35;
  if (/floor|tile|lvp|vinyl/.test(q) && /floor|tile|vinyl|laminate/.test(blob)) s += 30;
  if (isAreaUnit(String(hit.unit || ''), String(hit.raw_unit || ''))) s += 10;
  // Prefer residential wall paint emulsions over metal/trim/industrial
  if (/paint/.test(q)) {
    if (/water-?emulsion|polyvinyl|acrylic|latex|wall|plaster and prefabricated|textured compound/.test(blob)) {
      s += 45;
    }
    if (/high-?quality|improved|dual|two\s*coat/.test(blob)) s += 15;
    if (/simple[, ]|economy/.test(blob) && !/high-?quality|improved/.test(blob)) s -= 8;
    if (/painting|paint work|recoat|coat/.test(blob)) s += 20;
    if (/leveling|plastering up to|mortar mixtures/.test(name)) s -= 25;
    if (/metal|cornice|firewall|steel|iron|pipe|radiator|fence|grille/.test(blob)) s -= 60;
    if (/oil-based compounds of previously painted metal/.test(name)) s -= 80;
  }
  return s;
}

/** Focused BuildCalculator queries — generic "interior painting" returns metal trim rates. */
function buildSearchQueries(jobDescription: string): string[] {
  const q = String(jobDescription || '').trim();
  const queries: string[] = [];
  if (/paint|painting|primer/i.test(q)) {
    if (/exterior/i.test(q) && /interior/i.test(q)) {
      queries.push(
        'high-quality painting polyvinyl acetate water-emulsion interiors',
        'painting walls exteriors emulsion residential',
        'interior and exterior painting walls dual coat residential'
      );
    } else if (/exterior|outside/i.test(q)) {
      queries.push(
        'painting exterior walls facade emulsion residential',
        'exterior painting walls residential'
      );
    } else {
      queries.push(
        'painting of walls interiors water emulsion',
        'high-quality painting polyvinyl acetate water-emulsion',
        'painting with polyvinyl acetate water-emulsion compounds improved',
        'interior painting walls dual coat residential'
      );
    }
  } else if (/drywall|sheetrock/i.test(q)) {
    queries.push('drywall gypsum board installation walls', 'gypsum board ceilings walls');
  } else if (/roof|shingle/i.test(q)) {
    queries.push('roofing asphalt shingles residential', 'roof covering installation');
  } else if (/floor|lvp|vinyl|tile|hardwood|carpet/i.test(q)) {
    queries.push('flooring installation residential', 'floor covering vinyl tile laminate');
  } else {
    queries.push(q.slice(0, 120));
  }
  // Always try a short raw snippet last
  if (q.length >= 3 && !queries.includes(q.slice(0, 120))) {
    queries.push(q.slice(0, 120));
  }
  return queries.slice(0, 4);
}

function normalizeHit(raw: any, query: string): BuildCalcHit {
  const unit = String(raw.unit || '');
  const rawUnit = String(raw.raw_unit || '');
  const totalPerUnit = Number(raw.pricing?.total_per_unit) || 0;
  const laborPerUnit = Number(raw.pricing?.labor_per_unit) || 0;
  const materialPerUnit = Number(raw.pricing?.material_per_unit) || 0;
  const equipmentPerUnit = Number(raw.pricing?.equipment_per_unit) || 0;
  const laborHoursTotal = Number(raw.labor?.labor_hours_total) || 0;
  const pkg = packageSizeFromRawUnit(rawUnit);
  const hoursPerPackageUnit = laborHoursTotal > 0 ? laborHoursTotal / pkg : 0;

  let totalPerSfUsd: number | null = null;
  let laborPerSfUsd: number | null = null;
  let materialPerSfUsd: number | null = null;
  let hoursPerSf: number | null = null;

  if (isAreaUnit(unit, rawUnit) && totalPerUnit > 0) {
    // pricing is per m2 → convert to per SF USD
    totalPerSfUsd = roundMoney(eurToUsd(totalPerUnit) / M2_TO_SF);
    laborPerSfUsd = roundMoney(eurToUsd(laborPerUnit) / M2_TO_SF);
    materialPerSfUsd = roundMoney(eurToUsd(materialPerUnit) / M2_TO_SF);
    hoursPerSf = hoursPerPackageUnit > 0 ? hoursPerPackageUnit / M2_TO_SF : null;
  }

  return {
    rateCode: String(raw.rate_code || ''),
    name: String(raw.name || ''),
    originalName: String(raw.original_name || raw.name || ''),
    unit,
    rawUnit,
    currency: String(raw.currency || 'EUR'),
    totalPerUnit,
    laborPerUnit,
    materialPerUnit,
    equipmentPerUnit,
    laborHoursTotal,
    laborHoursPerUnit: hoursPerPackageUnit,
    category: String(raw.classification?.category || ''),
    section: String(
      raw.classification?.section ||
        raw.classification?.department ||
        raw.classification?.collection ||
        ''
    ),
    totalPerSfUsd,
    laborPerSfUsd,
    materialPerSfUsd,
    hoursPerSf,
    score: scoreHit(raw, query),
  };
}

/**
 * Search BuildCalculator work items. Fails soft (returns empty) on network/rate limit.
 */
export async function searchBuildCalculator(
  query: string,
  options?: { top?: number; lang?: string; timeoutMs?: number }
): Promise<BuildCalcHit[]> {
  const q = String(query || '').trim();
  if (q.length < 2) return [];

  const top = Math.min(20, Math.max(1, options?.top ?? 8));
  const lang = options?.lang || 'en';
  const timeoutMs = options?.timeoutMs ?? 8000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const url = new URL(`${BASE}/search`);
    url.searchParams.set('q', q.slice(0, 200));
    url.searchParams.set('lang', lang);
    url.searchParams.set('top', String(top));

    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
      next: { revalidate: 0 },
    });
    if (!res.ok) {
      console.warn('BuildCalculator search HTTP', res.status);
      return [];
    }
    const data = await res.json().catch(() => ({}));
    const results = Array.isArray(data.results) ? data.results : [];
    return results
      .map((r: any) => normalizeHit(r, q))
      .sort((a: BuildCalcHit, b: BuildCalcHit) => b.score - a.score);
  } catch (e: any) {
    console.warn('BuildCalculator search failed:', e?.message || e);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** Parse floor/area SF from job description for scaling. */
function parseSfFromText(description: string): number | null {
  const m = String(description || '').match(
    /(\d[\d,]*)\s*(?:sq\.?\s*ft|sqft|sf|square\s*feet)\b/i
  );
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Build a quote anchor from BuildCalculator for a job description.
 * Scales per-unit costs to full job when floor SF is known.
 */
export async function buildCalculatorQuoteAnchor(
  jobDescription: string,
  options?: { regionalUsdBlend?: number }
): Promise<BuildCalcQuoteAnchor | null> {
  const query = String(jobDescription || '').trim().slice(0, 200);
  if (query.length < 3) return null;

  const searchQueries = buildSearchQueries(query);
  const searchQ = searchQueries[0] || query;

  // Parallel search a few focused queries; merge + re-score so metal-paint junk loses
  const hitBatches = await Promise.all(
    searchQueries.map((sq) => searchBuildCalculator(sq, { top: 6, timeoutMs: 7000 }))
  );
  const byCode = new Map<string, BuildCalcHit>();
  for (const batch of hitBatches) {
    for (const h of batch) {
      const key = h.rateCode || `${h.originalName}|${h.totalPerUnit}`;
      const prev = byCode.get(key);
      if (!prev || h.score > prev.score) byCode.set(key, h);
    }
  }
  const hits = Array.from(byCode.values()).sort((a, b) => b.score - a.score);
  if (!hits.length) return null;

  // Prefer area rates that look like installed wall/floor work (not industrial extremes).
  // Use the median of top good hits so successive searches don't flip between cheap/expensive lines.
  const goodHits = hits.filter(
    (h) =>
      h.totalPerSfUsd != null &&
      h.totalPerSfUsd > 0.35 &&
      h.totalPerSfUsd < 25 &&
      h.score >= 30
  );
  const pool =
    goodHits.length > 0
      ? goodHits
      : hits.filter((h) => h.totalPerSfUsd != null && h.totalPerSfUsd > 0.35 && h.totalPerSfUsd < 40);
  let best: BuildCalcHit | null = pool[0] || hits[0] || null;
  if (pool.length >= 3) {
    const sorted = [...pool]
      .filter((h) => h.totalPerSfUsd != null)
      .sort((a, b) => (a.totalPerSfUsd || 0) - (b.totalPerSfUsd || 0));
    best = sorted[Math.floor(sorted.length / 2)] || best;
  }

  const floorSf = parseSfFromText(query);
  // Surface multiplier for whole-home paint int+ext dual coat vs floor SF
  let surfaceMult = 1;
  if (/paint/i.test(query) && floorSf && floorSf >= 400) {
    if (/exterior/i.test(query) && /interior/i.test(query)) surfaceMult = 4.0;
    else if (/exterior|outside/i.test(query)) surfaceMult = 1.35;
    else surfaceMult = 3.0; // interior walls+ceilings
    if (/dual|two\s*coat|2\s*coat|double/i.test(query)) surfaceMult *= 1.05;
  }

  const surfaceSf = floorSf ? Math.round(floorSf * surfaceMult) : null;
  const regional = options?.regionalUsdBlend && options.regionalUsdBlend > 0 ? options.regionalUsdBlend : 1;

  // RAW base unit cost (USD) before EstimationPro / regional multipliers
  let baseSurfacePerSf: number | null =
    best?.totalPerSfUsd != null && best.totalPerSfUsd > 0 ? roundMoney(best.totalPerSfUsd) : null;
  let baseFloorPerSf: number | null = baseSurfacePerSf;
  if (baseSurfacePerSf != null && floorSf && surfaceSf && surfaceSf > floorSf) {
    // Convert surface installed $/SF → home floor $/SF for line billing
    baseFloorPerSf = roundMoney((baseSurfacePerSf * surfaceSf) / floorSf);
  }

  // Optional legacy blend (prefer applying EstimationPro multiplier outside instead)
  let suggestedPerSfUsd: number | null =
    baseFloorPerSf != null ? roundMoney(baseFloorPerSf * regional) : null;

  let suggestedJobTotalUsd: number | null = null;
  let suggestedLaborHours: number | null = null;
  if (surfaceSf && baseSurfacePerSf != null) {
    suggestedJobTotalUsd = roundMoney(baseSurfacePerSf * surfaceSf * regional);
  }
  if (surfaceSf && best?.hoursPerSf != null && best.hoursPerSf > 0) {
    suggestedLaborHours = roundMoney(
      Math.min(120, Math.max(8, surfaceSf * best.hoursPerSf))
    );
  } else if (floorSf && /paint/i.test(query)) {
    suggestedLaborHours = roundMoney(Math.min(100, Math.max(24, floorSf / 16)));
  }

  const top = hits.slice(0, 4);
  const lines = top.map((h, i) => {
    const perSf =
      h.totalPerSfUsd != null
        ? `~$${h.totalPerSfUsd.toFixed(2)}/SF surface (from €${h.totalPerUnit.toFixed(2)}/${h.unit})`
        : `€${h.totalPerUnit.toFixed(2)}/${h.unit}`;
    return `${i + 1}. ${h.originalName.slice(0, 120)} — ${perSf}; labor ~${h.laborHoursPerUnit.toFixed(3)} hrs per ${h.unit}`;
  });

  const promptBlock = [
    'BUILDCALCULATOR.IO UNIT COSTS (BASE — before regional multiplier):',
    `Search: "${searchQ}"`,
    ...lines,
    baseFloorPerSf != null
      ? `Base unit cost (USD): $${baseFloorPerSf.toFixed(2)} per SF of home floor (from BuildCalculator). Apply EstimationPro regional multiplier next for local market.`
      : '',
    'For SF billing: suggestedQty = home floor sqft; unitPrice = regionalized total ÷ qty; total = unitPrice × qty.',
  ]
    .filter(Boolean)
    .join('\n');

  return {
    source: 'buildcalculator.io',
    query: searchQ,
    currency: 'USD',
    hits: top,
    best,
    suggestedJobTotalUsd,
    suggestedLaborHours,
    suggestedPerSfUsd,
    baseUnitCostUsd: baseFloorPerSf,
    billingQuantity: floorSf || surfaceSf,
    surfaceSf,
    floorSf,
    promptBlock,
  };
}
