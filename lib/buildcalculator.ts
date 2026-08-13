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
  /** $/SF floor or surface (USD) for installed work */
  suggestedPerSfUsd: number | null;
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
  let s = 0;
  if (/paint|painting|primer|coat/.test(q) && /paint|painting|finish|plaster|wall/.test(name + cat)) s += 40;
  if (/exterior|outside/.test(q) && /exterior|outside|facade|façade/.test(name + cat)) s += 20;
  if (/interior|inside/.test(q) && /interior|inside|indoor|room/.test(name + cat)) s += 20;
  if (/drywall|sheetrock|plaster/.test(q) && /drywall|plaster|gypsum|sheetrock/.test(name + cat)) s += 35;
  if (/roof|shingle/.test(q) && /roof|shingle/.test(name + cat)) s += 35;
  if (/floor|tile|lvp|vinyl/.test(q) && /floor|tile|vinyl|laminate/.test(name + cat)) s += 30;
  if (isAreaUnit(String(hit.unit || ''), String(hit.raw_unit || ''))) s += 10;
  // Prefer painting over plaster leveling when query is paint
  if (/paint/.test(q) && /leveling|plastering up to|mortar mixtures/.test(name)) s -= 15;
  if (/paint/.test(q) && /painting|paint work|recoat|coat/.test(name + cat)) s += 25;
  return s;
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
      // @ts-expect-error next/node
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

  // Prefer a focused search query for better matches
  let searchQ = query;
  if (/paint|painting/i.test(query)) {
    if (/exterior/i.test(query) && /interior/i.test(query)) {
      searchQ = 'interior and exterior painting walls dual coat residential';
    } else if (/exterior|outside/i.test(query)) {
      searchQ = 'exterior painting walls residential';
    } else {
      searchQ = 'interior painting walls dual coat residential';
    }
  }

  const hits = await searchBuildCalculator(searchQ, { top: 8 });
  if (!hits.length) {
    // Fallback: raw description
    const fallback = await searchBuildCalculator(query, { top: 5 });
    if (!fallback.length) return null;
    hits.push(...fallback);
  }

  const best =
    hits.find((h) => h.totalPerSfUsd != null && h.totalPerSfUsd > 0.5 && h.totalPerSfUsd < 40) ||
    hits[0] ||
    null;

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

  let suggestedPerSfUsd: number | null = best?.totalPerSfUsd
    ? roundMoney(best.totalPerSfUsd * regional)
    : null;
  // For whole-home floor billing, convert surface $/SF to floor $/SF
  let floorBillingPerSf: number | null = null;
  if (suggestedPerSfUsd != null && floorSf && surfaceSf && surfaceSf > floorSf) {
    floorBillingPerSf = roundMoney((suggestedPerSfUsd * surfaceSf) / floorSf);
  } else {
    floorBillingPerSf = suggestedPerSfUsd;
  }

  let suggestedJobTotalUsd: number | null = null;
  let suggestedLaborHours: number | null = null;
  if (surfaceSf && best?.totalPerSfUsd) {
    suggestedJobTotalUsd = roundMoney(best.totalPerSfUsd * surfaceSf * regional);
  }
  if (surfaceSf && best?.hoursPerSf != null && best.hoursPerSf > 0) {
    suggestedLaborHours = roundMoney(
      Math.min(120, Math.max(8, surfaceSf * best.hoursPerSf * regional))
    );
  } else if (floorSf && /paint/i.test(query)) {
    // Fallback production if API hours missing
    suggestedLaborHours = roundMoney(Math.min(100, Math.max(24, floorSf / 16)));
  }

  const top = hits.slice(0, 4);
  const lines = top.map((h, i) => {
    const perSf =
      h.totalPerSfUsd != null
        ? `~$${h.totalPerSfUsd.toFixed(2)}/SF (from €${h.totalPerUnit.toFixed(2)}/${h.unit})`
        : `€${h.totalPerUnit.toFixed(2)}/${h.unit}`;
    return `${i + 1}. ${h.originalName.slice(0, 120)} — ${perSf}; labor ~${h.laborHoursPerUnit.toFixed(3)} hrs per ${h.unit}`;
  });

  const promptBlock = [
    'BUILDCALCULATOR.IO PRICING DATA (authoritative cost database — use to ground your bid):',
    `Search: "${searchQ}"`,
    ...lines,
    best && floorBillingPerSf != null
      ? `Recommended anchor for this job: about $${floorBillingPerSf.toFixed(2)} per SF of HOME FLOOR area (installed), full job total ≈ $${(suggestedJobTotalUsd || 0).toFixed(0)}${suggestedLaborHours ? `, labor ≈ ${suggestedLaborHours} crew-hours` : ''}.`
      : '',
    'Convert metric/EUR database rates into a realistic US homeowner-facing contractor price. Prefer this data over inventing rates.',
    'For SF billing: suggestedQty = home floor sqft from the description; unitPrice = total ÷ suggestedQty; total = unitPrice × suggestedQty.',
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
    suggestedPerSfUsd: floorBillingPerSf,
    promptBlock,
  };
}
