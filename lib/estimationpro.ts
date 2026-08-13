/**
 * EstimationPro.ai Construction Cost API
 * https://estimationpro.ai/tools/api
 *
 * Free public API: regional multipliers by ZIP/state + trade cost items (low/typical/high).
 * No API key. ~100 req/day/IP on most endpoints.
 */

const BASE = 'https://estimationpro.ai/api/v1';

export type EstimationProMultiplier = {
  location: string;
  resolvedState: string;
  region: string;
  multiplier: number;
  laborMultiplier: number;
  label: string;
  source: string;
};

export type EstimationProCostItem = {
  id: string;
  description: string;
  unit: string;
  low: number;
  typical: number;
  high: number;
  regionallyAdjusted: boolean;
};

export type EstimationProTradeCosts = {
  trade: string;
  location: string;
  multiplier: number;
  items: EstimationProCostItem[];
};

function roundMoney(n: number) {
  return Math.round(Math.max(0, n) * 100) / 100;
}

async function epGet<T>(path: string, timeoutMs = 8000): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn('EstimationPro HTTP', res.status, path);
      return null;
    }
    const json = await res.json().catch(() => null);
    return (json?.data ?? json) as T;
  } catch (e: any) {
    console.warn('EstimationPro failed:', e?.message || e);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Map job description → EstimationPro trade slug */
export function detectEstimationProTrade(description: string): string {
  const t = String(description || '').toLowerCase();
  if (/roof|shingle|re-?roof/.test(t)) return 'roofing';
  if (/drywall|sheetrock|mud\b|tape/.test(t)) return 'drywall';
  if (/paint|painting|primer|coat/.test(t)) return 'paint';
  if (/floor|lvp|vinyl\s*plank|hardwood|carpet/.test(t)) return 'flooring';
  if (/tile|ceramic|porcelain/.test(t)) return 'tile';
  if (/siding/.test(t)) return 'siding';
  if (/stucco/.test(t)) return 'stucco';
  if (/fence/.test(t)) return 'fence';
  if (/deck/.test(t)) return 'deck';
  if (/plumb|toilet|faucet|water\s*heater/.test(t)) return 'plumbing';
  if (/electric|outlet|panel|wiring/.test(t)) return 'electrical';
  if (/hvac|furnace|ac\b|air\s*condition/.test(t)) return 'hvac';
  if (/window/.test(t)) return 'windows';
  if (/door/.test(t)) return 'doors';
  if (/kitchen/.test(t)) return 'kitchen-remodel';
  if (/bath/.test(t)) return 'bathroom-remodel';
  if (/concrete|slab|sidewalk/.test(t)) return 'concrete';
  if (/insulation/.test(t)) return 'insulation';
  if (/gutter/.test(t)) return 'gutters';
  if (/demo|demolition|tear\s*out/.test(t)) return 'demolition';
  if (/framing|frame/.test(t)) return 'framing';
  return 'labor-general';
}

export async function fetchEstimationProMultiplier(input: {
  zipCode?: string;
  state?: string;
}): Promise<EstimationProMultiplier | null> {
  const zip = String(input.zipCode || '')
    .replace(/\D/g, '')
    .slice(0, 5);
  const state = String(input.state || '')
    .trim()
    .toUpperCase()
    .slice(0, 2);
  if (!zip && !state) return null;

  const qs = zip ? `zip=${zip}` : `state=${state}`;
  const data = await epGet<any>(`/multipliers?${qs}`);
  if (!data || typeof data.multiplier !== 'number') return null;

  return {
    location: String(data.location || zip || state),
    resolvedState: String(data.resolvedState || state || ''),
    region: String(data.region || ''),
    multiplier: Number(data.multiplier) || 1,
    laborMultiplier: Number(data.regionDetail?.laborMultiplier) || Number(data.multiplier) || 1,
    label: String(data.label || ''),
    source: String(data.source || 'estimationpro'),
  };
}

export async function fetchEstimationProTradeCosts(input: {
  trade: string;
  zipCode?: string;
  state?: string;
}): Promise<EstimationProTradeCosts | null> {
  const trade = String(input.trade || '').trim();
  if (!trade) return null;
  const zip = String(input.zipCode || '')
    .replace(/\D/g, '')
    .slice(0, 5);
  const state = String(input.state || '')
    .trim()
    .toUpperCase()
    .slice(0, 2);
  const params = new URLSearchParams({ trade });
  if (zip) params.set('zip', zip);
  else if (state) params.set('state', state);

  const data = await epGet<any>(`/costs?${params.toString()}`);
  if (!data || !Array.isArray(data.items)) return null;

  return {
    trade: String(data.trade || trade),
    location: String(data.location || ''),
    multiplier: Number(data.multiplier) || 1,
    items: data.items.map((it: any) => ({
      id: String(it.id || ''),
      description: String(it.description || ''),
      unit: String(it.unit || ''),
      low: Number(it.low) || 0,
      typical: Number(it.typical) || 0,
      high: Number(it.high) || 0,
      regionallyAdjusted: !!it.regionallyAdjusted,
    })),
  };
}

export type PriceRange = {
  low: number;
  typical: number;
  high: number;
  perSf?: { low: number; typical: number; high: number } | null;
  unit: string;
  quantity: number;
  /** Human summary for UI */
  label: string;
  sources: string[];
};

/**
 * Combine BuildCalculator unit cost (base) × EstimationPro regional multiplier
 * and produce low–typical–high range for the full job.
 */
export function applyEpMultiplierToBuildCalcBase(input: {
  /** BuildCalculator installed unit cost in USD (e.g. per SF of surface or floor) */
  baseUnitCostUsd: number;
  /** Quantity in same unit as base (e.g. SF) */
  quantity: number;
  /** EstimationPro regional multiplier (1.0 = national) */
  epMultiplier: number;
  /** Optional EP labor low/typical/high per SF for range shape */
  epLaborPerSf?: { low: number; typical: number; high: number } | null;
  unitLabel?: string;
  /** Spread for low/high when EP labor band missing (0.15 = ±15%) */
  spread?: number;
}): PriceRange {
  const qty = Math.max(1, Number(input.quantity) || 1);
  const mult = Number(input.epMultiplier) > 0 ? Number(input.epMultiplier) : 1;
  const spread = input.spread != null ? Math.min(0.4, Math.max(0.08, input.spread)) : 0.18;
  const base = Math.max(0, Number(input.baseUnitCostUsd) || 0);

  // Base from BuildCalculator (already converted to billing $/SF), then regionalize once.
  // Do NOT re-multiply EP labor bands by the regional multiplier when blending —
  // EstimationPro /costs items are often already regionally adjusted.
  let typicalPer = roundMoney(base * mult);
  let lowPer = roundMoney(typicalPer * (1 - spread));
  let highPer = roundMoney(typicalPer * (1 + spread));

  const ep = input.epLaborPerSf;
  if (ep && ep.typical > 0) {
    const epLowRatio = ep.low / ep.typical;
    const epHighRatio = ep.high / ep.typical;
    // Shape the range from EP labor spread, but keep BC×mult as the center of gravity
    lowPer = roundMoney(typicalPer * Math.min(0.92, Math.max(0.65, epLowRatio)));
    highPer = roundMoney(typicalPer * Math.max(1.08, Math.min(1.55, epHighRatio)));
    // Light blend only — EP labor is labor-only $/SF, BC base is full installed $/SF
    // so we must NOT treat ep.typical as a full-job installed rate.
    const epAsInstalledHint = roundMoney(ep.typical * mult * 1.35); // labor → rough installed
    if (epAsInstalledHint > typicalPer * 0.5 && epAsInstalledHint < typicalPer * 1.4) {
      typicalPer = roundMoney(typicalPer * 0.85 + epAsInstalledHint * 0.15);
    }
    lowPer = Math.min(lowPer, typicalPer);
    highPer = Math.max(highPer, typicalPer);
  }

  const unit = input.unitLabel || 'SF';
  return {
    low: roundMoney(lowPer * qty),
    typical: roundMoney(typicalPer * qty),
    high: roundMoney(highPer * qty),
    perSf: {
      low: lowPer,
      typical: typicalPer,
      high: highPer,
    },
    unit,
    quantity: qty,
    label: `$${roundMoney(lowPer * qty).toLocaleString()} – $${roundMoney(highPer * qty).toLocaleString()} (typical $${roundMoney(typicalPer * qty).toLocaleString()})`,
    sources: [
      'BuildCalculator.io unit costs (base)',
      `EstimationPro.ai regional multiplier ×${mult.toFixed(2)}`,
    ],
  };
}

/** Pick EP paint labor band for interior / exterior / both */
export function pickPaintLaborBand(
  costs: EstimationProTradeCosts | null,
  description: string
): { low: number; typical: number; high: number } | null {
  if (!costs?.items?.length) return null;
  const t = description.toLowerCase();
  const intItem = costs.items.find((i) => i.id === 'paint-interior-labor');
  const extItem = costs.items.find((i) => i.id === 'paint-exterior-labor');
  const both = /exterior/.test(t) && /interior/.test(t);
  if (both && intItem && extItem) {
    // Combined floor-area billing: blend int+ext labor into one $/SF floor figure
    return {
      low: roundMoney(intItem.low * 0.55 + extItem.low * 0.45),
      typical: roundMoney(intItem.typical * 0.55 + extItem.typical * 0.45),
      high: roundMoney(intItem.high * 0.55 + extItem.high * 0.45),
    };
  }
  if (/exterior|outside/.test(t) && extItem) {
    return { low: extItem.low, typical: extItem.typical, high: extItem.high };
  }
  if (intItem) {
    return { low: intItem.low, typical: intItem.typical, high: intItem.high };
  }
  const anySf = costs.items.find((i) => /sq\s*ft/i.test(i.unit) && i.typical > 0);
  if (anySf) return { low: anySf.low, typical: anySf.typical, high: anySf.high };
  return null;
}
