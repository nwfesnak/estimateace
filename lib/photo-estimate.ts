/**
 * Photo → line-item estimate (pure helpers; the route is app/api/photo-estimate).
 *
 * Grok vision proposes WHAT the job is (lines, quantities, materials, labor hours).
 * The money math is done here, deterministically: trade-aware labor rates + material
 * markup, regional multipliers, the contractor's remembered prices. Every line obeys
 * materials + labor === line total, like the existing AI Price Quote.
 */
import type { RegionalPricing } from '@/lib/ai-quote-region';
import {
  applyPriceMemoryToBreakdown,
  normalizeAiPriceMemory,
  type AiPriceMemory,
} from '@/lib/ai-price-memory';

export const PHOTO_ESTIMATE_LIMITS = {
  maxPhotos: 5,
  /** Per photo, as a data URL string (client compresses to ~1600px JPEG first). */
  maxPhotoChars: 1_000_000,
  /** All photos together (Vercel request body limit is ~4.5 MB). */
  /** Keep the whole JSON body under Vercel's 4.5 MB request limit. */
  maxTotalChars: 3_600_000,
  maxNoteChars: 1500,
  maxLines: 20,
  maxUpsells: 6,
  maxMaterialsPerLine: 12,
  /** Sanity caps so one bad AI number can't produce a $2M line. */
  maxQty: 100_000,
  maxUnitCost: 25_000,
  maxLaborHours: 400,
} as const;

/** Billable labor $/hr and material markup % by trade (US mid-market starting points). */
export const TRADE_PRICING_DEFAULTS: Record<string, { laborRate: number; markupPercent: number; label: string }> = {
  painting: { laborRate: 55, markupPercent: 20, label: 'Painting' },
  'pressure-washing': { laborRate: 60, markupPercent: 15, label: 'Pressure washing' },
  landscaping: { laborRate: 50, markupPercent: 25, label: 'Landscaping' },
  handyman: { laborRate: 70, markupPercent: 20, label: 'Handyman' },
  remodeling: { laborRate: 75, markupPercent: 25, label: 'Remodeling' },
  roofing: { laborRate: 70, markupPercent: 25, label: 'Roofing' },
  flooring: { laborRate: 60, markupPercent: 20, label: 'Flooring' },
  plumbing: { laborRate: 105, markupPercent: 30, label: 'Plumbing' },
  electrical: { laborRate: 100, markupPercent: 30, label: 'Electrical' },
  hvac: { laborRate: 110, markupPercent: 30, label: 'HVAC' },
  concrete: { laborRate: 65, markupPercent: 20, label: 'Concrete' },
  fencing: { laborRate: 55, markupPercent: 20, label: 'Fencing' },
  carpentry: { laborRate: 70, markupPercent: 20, label: 'Carpentry' },
  'windows-doors': { laborRate: 75, markupPercent: 25, label: 'Windows & doors' },
  insulation: { laborRate: 55, markupPercent: 25, label: 'Insulation' },
  masonry: { laborRate: 75, markupPercent: 20, label: 'Masonry' },
  siding: { laborRate: 65, markupPercent: 25, label: 'Siding' },
  drywall: { laborRate: 60, markupPercent: 20, label: 'Drywall' },
  general: { laborRate: 65, markupPercent: 20, label: 'General contracting' },
};

export function tradeDefaults(tradeId: string | null | undefined) {
  const id = String(tradeId || '').trim().toLowerCase();
  return TRADE_PRICING_DEFAULTS[id] || TRADE_PRICING_DEFAULTS.general;
}

/** Room measurements (LiDAR scan or typed in). All optional. */
export type RoomMeasurements = {
  floorSqft?: number;
  wallSqft?: number;
  perimeterLf?: number;
  ceilingFt?: number;
  doors?: number;
  windows?: number;
  source?: 'lidar' | 'manual';
};

export function sanitizeMeasurements(raw: unknown): RoomMeasurements | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown, max: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 && n <= max ? Math.round(n * 10) / 10 : undefined;
  };
  const out: RoomMeasurements = {
    floorSqft: num(r.floorSqft, 50_000),
    wallSqft: num(r.wallSqft, 100_000),
    perimeterLf: num(r.perimeterLf, 10_000),
    ceilingFt: num(r.ceilingFt, 60),
    doors: num(r.doors, 100),
    windows: num(r.windows, 200),
    source: r.source === 'lidar' ? 'lidar' : r.source === 'manual' ? 'manual' : undefined,
  };
  const any = Object.entries(out).some(([k, v]) => k !== 'source' && v !== undefined);
  return any ? out : null;
}

export function buildPhotoEstimatePrompt(input: {
  note?: string;
  tradeLabel: string;
  regionLabel?: string;
  measurements?: RoomMeasurements | null;
  priceMemoryPrompt?: string;
  photoCount: number;
}): string {
  const m = input.measurements;
  const meas = m
    ? `\nMEASURED ON SITE${m.source === 'lidar' ? ' (LiDAR room scan — trust these over the photos)' : ''}: ` +
      [
        m.floorSqft ? `floor ${m.floorSqft} sq ft` : '',
        m.wallSqft ? `walls ${m.wallSqft} sq ft (openings removed)` : '',
        m.perimeterLf ? `perimeter ${m.perimeterLf} LF` : '',
        m.ceilingFt ? `ceiling height ${m.ceilingFt} ft` : '',
        m.doors ? `${m.doors} doors` : '',
        m.windows ? `${m.windows} windows` : '',
      ]
        .filter(Boolean)
        .join(', ')
    : '';
  return `You are a senior ${input.tradeLabel} estimator. Look at the ${input.photoCount} job-site photo(s) and write an itemized estimate a contractor can send.
${input.note ? `\nCONTRACTOR NOTE: ${input.note}` : ''}${meas}
${input.regionLabel ? `\nJob region: ${input.regionLabel}. Use US national-average material costs; the app adjusts for region.` : ''}
${input.priceMemoryPrompt ? `\n${input.priceMemoryPrompt}` : ''}

Rules:
- One line per distinct piece of work (e.g. "Prep and paint walls", "Replace baseboard"). 1-${PHOTO_ESTIMATE_LIMITS.maxLines} lines.
- Each line: qty + unit the customer sees (SF, LF, EA, SQ, HR, LS), the materials with qty/unit/unitCost (YOUR cost, before markup), and laborHours for that line.
- Small repairs stay small. Never invent rooms or work you can't see or weren't told about.
- If a quantity is a guess from the photo, say so in "assumptions".
- "upsells": optional add-ons the customer may want (e.g. ceiling paint, new trim, sealing), same shape plus a short "reason". 0-${PHOTO_ESTIMATE_LIMITS.maxUpsells}.
- No markup, no tax, no totals — the app computes money.

Return ONLY JSON:
{"scopeSummary":"","trade":"","confidence":"high|medium|low",
 "lines":[{"description":"","qty":0,"unit":"SF","laborHours":0,"materials":[{"description":"","qty":0,"unit":"","unitCost":0}]}],
 "upsells":[{"description":"","reason":"","qty":0,"unit":"","laborHours":0,"materials":[]}],
 "assumptions":[""],"questions":[""]}`;
}

export type PricedMaterial = { description: string; qty: number; unit: string; unitPrice: number; total: number };
export type PricedLabor = { description: string; hours: number; rate: number; total: number };
export type PricedLine = {
  description: string;
  qty: number;
  unit: string;
  unitPrice: number;
  total: number;
  materialsList: PricedMaterial[];
  laborBreakdown: PricedLabor | null;
  materialMarkupPercent: number;
  reason?: string;
};

export type PhotoEstimateResult = {
  scopeSummary: string;
  trade: string;
  confidence: 'high' | 'medium' | 'low';
  lines: PricedLine[];
  upsells: PricedLine[];
  assumptions: string[];
  questions: string[];
  laborRate: number;
  markupPercent: number;
  subtotal: number;
};

const money = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const clampNum = (v: unknown, max: number, min = 0) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
};
const str = (v: unknown, max: number) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const UNIT_RE = /^[A-Za-z. /]{1,8}$/;

export function parseAiJson(text: string): Record<string, unknown> | null {
  const stripped = String(text || '').replace(/```json\s*/gi, '').replace(/```/g, '').trim();
  const m = stripped.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const v = JSON.parse(m[0]);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Turn one AI line into a priced line (materials marked up, labor at the rate). */
export function priceLine(
  raw: unknown,
  opts: {
    laborRate: number;
    markupPercent: number;
    materialMultiplier: number;
    priceMemory?: AiPriceMemory | null;
  }
): PricedLine | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const description = str(r.description, 300);
  if (description.length < 3) return null;
  const L = PHOTO_ESTIMATE_LIMITS;
  const unitRaw = str(r.unit, 8).toUpperCase();
  const unit = UNIT_RE.test(unitRaw) ? unitRaw : 'LS';
  const qty = Math.round(clampNum(r.qty, L.maxQty) * 100) / 100 || 1;

  const rawMaterials = (Array.isArray(r.materials) ? r.materials : []).slice(0, L.maxMaterialsPerLine);
  let materials: PricedMaterial[] = rawMaterials
    .map((m) => {
      const mm = (m || {}) as Record<string, unknown>;
      const d = str(mm.description ?? mm.name, 160);
      if (!d) return null;
      const mq = Math.round(clampNum(mm.qty, L.maxQty) * 100) / 100 || 1;
      const cost = clampNum(mm.unitCost ?? mm.unitPrice, L.maxUnitCost) * (opts.materialMultiplier || 1);
      const unitPrice = money(cost * (1 + opts.markupPercent / 100));
      return { description: d, qty: mq, unit: str(mm.unit, 12) || 'ea', unitPrice, total: money(mq * unitPrice) };
    })
    .filter((m): m is PricedMaterial => !!m);

  const hours = Math.round(clampNum(r.laborHours, L.maxLaborHours) * 10) / 10;
  let labor: PricedLabor | null =
    hours > 0
      ? { description: 'Labor', hours, rate: money(opts.laborRate), total: money(hours * opts.laborRate) }
      : null;

  // The contractor's remembered material prices / labor rate win (already their sell price).
  if (opts.priceMemory) {
    const applied = applyPriceMemoryToBreakdown(materials, labor, opts.priceMemory);
    materials = applied.materials as PricedMaterial[];
    labor = applied.labor;
  }

  const total = money(materials.reduce((s, m) => s + m.total, 0) + (labor?.total || 0));
  if (total <= 0) return null;
  return {
    description,
    qty,
    unit,
    unitPrice: money(total / qty),
    total,
    materialsList: materials,
    laborBreakdown: labor,
    materialMarkupPercent: opts.markupPercent,
    ...(r.reason ? { reason: str(r.reason, 200) } : {}),
  };
}

/** Normalize the whole AI answer into a priced, capped estimate. */
export function buildPhotoEstimate(
  ai: Record<string, unknown>,
  opts: {
    tradeId?: string | null;
    markupPercent?: number | null;
    regional?: Pick<RegionalPricing, 'materialMultiplier' | 'laborMultiplier'> | null;
    priceMemory?: unknown;
  }
): PhotoEstimateResult {
  const trade = tradeDefaults(opts.tradeId || str(ai.trade, 40).toLowerCase());
  const memory = normalizeAiPriceMemory(opts.priceMemory);
  const laborRate = money(
    memory.laborRate && memory.laborRate > 0
      ? memory.laborRate
      : trade.laborRate * (opts.regional?.laborMultiplier || 1)
  );
  const markup = Number(opts.markupPercent);
  const markupPercent = Number.isFinite(markup) && markup >= 0 && markup <= 200 ? markup : trade.markupPercent;
  const pricing = {
    laborRate,
    markupPercent,
    materialMultiplier: opts.regional?.materialMultiplier || 1,
    priceMemory: memory,
  };
  const lines = (Array.isArray(ai.lines) ? ai.lines : [])
    .slice(0, PHOTO_ESTIMATE_LIMITS.maxLines)
    .map((l) => priceLine(l, pricing))
    .filter((l): l is PricedLine => !!l);
  const upsells = (Array.isArray(ai.upsells) ? ai.upsells : [])
    .slice(0, PHOTO_ESTIMATE_LIMITS.maxUpsells)
    .map((l) => priceLine(l, pricing))
    .filter((l): l is PricedLine => !!l);
  const conf = str(ai.confidence, 10).toLowerCase();
  const list = (v: unknown) =>
    (Array.isArray(v) ? v : []).map((x) => str(x, 240)).filter(Boolean).slice(0, 8);
  return {
    scopeSummary: str(ai.scopeSummary, 600),
    trade: trade.label,
    confidence: conf === 'high' || conf === 'low' ? conf : 'medium',
    lines,
    upsells,
    assumptions: list(ai.assumptions),
    questions: list(ai.questions),
    laborRate,
    markupPercent,
    subtotal: money(lines.reduce((s, l) => s + l.total, 0)),
  };
}

/**
 * Contractor edited qty or unit price in the review screen: keep the line total and the
 * materials + labor breakdown in agreement by scaling the breakdown to the new total.
 */
export function applyLineEdit(line: PricedLine, edit: { qty?: number; unitPrice?: number; description?: string; unit?: string }): PricedLine {
  const qty = edit.qty != null && Number(edit.qty) > 0 ? Math.round(Number(edit.qty) * 100) / 100 : line.qty;
  const unitPrice =
    edit.unitPrice != null && Number(edit.unitPrice) >= 0 ? money(Number(edit.unitPrice)) : line.unitPrice;
  const total = money(qty * unitPrice);
  const oldTotal = line.materialsList.reduce((s, m) => s + m.total, 0) + (line.laborBreakdown?.total || 0);
  const k = oldTotal > 0 ? total / oldTotal : 0;
  const materialsList = line.materialsList.map((m) => {
    const t = money(m.total * k);
    return { ...m, total: t, unitPrice: m.qty > 0 ? money(t / m.qty) : t };
  });
  let laborBreakdown = line.laborBreakdown
    ? {
        ...line.laborBreakdown,
        total: money(line.laborBreakdown.total * k),
        rate: line.laborBreakdown.hours > 0 ? money((line.laborBreakdown.total * k) / line.laborBreakdown.hours) : line.laborBreakdown.rate,
      }
    : null;
  // Put any rounding cent on labor (or the last material) so the parts add up exactly.
  const parts = money(materialsList.reduce((s, m) => s + m.total, 0) + (laborBreakdown?.total || 0));
  const diff = money(total - parts);
  if (diff !== 0) {
    if (laborBreakdown) laborBreakdown = { ...laborBreakdown, total: money(laborBreakdown.total + diff) };
    else if (materialsList.length) {
      const last = materialsList[materialsList.length - 1];
      materialsList[materialsList.length - 1] = { ...last, total: money(last.total + diff) };
    }
  }
  return {
    ...line,
    description: edit.description != null ? str(edit.description, 300) || line.description : line.description,
    unit: edit.unit != null ? str(edit.unit, 8).toUpperCase() || line.unit : line.unit,
    qty,
    unitPrice,
    total,
    materialsList,
    laborBreakdown,
  };
}

/** Estimate row in the existing document model (app/page.tsx items[]). */
export function toEstimateItem(line: PricedLine, opts: { id: number; optional?: boolean }) {
  return {
    id: opts.id,
    description: line.description,
    qty: line.qty,
    unit: line.unit,
    price: line.unitPrice,
    total: line.total,
    materialsList: line.materialsList,
    materialBreakdown: null,
    laborBreakdown: line.laborBreakdown,
    materialMarkupPercent: line.materialMarkupPercent,
    breakdownUserEdited: true,
    breakdownLocked: true,
    aiSource: 'photo-estimate',
    ...(opts.optional ? { optional: true } : {}),
  };
}

/** Validate photos sent as data URLs. Returns an error message or the cleaned list. */
export function validatePhotos(raw: unknown): { photos: string[] } | { error: string; status: number } {
  const L = PHOTO_ESTIMATE_LIMITS;
  const list = Array.isArray(raw) ? raw : [];
  if (list.length === 0) return { error: 'Add at least one job photo.', status: 400 };
  if (list.length > L.maxPhotos) return { error: `Up to ${L.maxPhotos} photos per estimate.`, status: 400 };
  const photos: string[] = [];
  let totalChars = 0;
  for (const p of list) {
    const s = String(p || '').trim();
    if (!/^data:image\/(jpeg|jpg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(s)) {
      return { error: 'Photos must be JPEG, PNG or WebP images.', status: 400 };
    }
    if (s.length > L.maxPhotoChars) return { error: 'A photo is too large. Try again (photos are shrunk automatically).', status: 413 };
    totalChars += s.length;
    photos.push(s);
  }
  if (totalChars > L.maxTotalChars) return { error: 'Photos are too large together. Use fewer photos.', status: 413 };
  return { photos };
}

/** Finish ideas for the before/after rendering (tap to fill the notes box). */
export const RENDER_FINISH_PRESETS = [
  'Charcoal architectural shingles, white trim',
  'Fresh white walls, matte black trim and doors',
  'Light oak luxury vinyl plank flooring',
  'White shaker cabinets, quartz counters, subway tile',
  'Navy board-and-batten siding, white trim',
  'Stamped concrete patio, gray ashlar slate',
  'Cedar privacy fence, natural stain',
  'Fresh mulch beds, trimmed shrubs, green lawn',
];

/** Map a failed response to a message the contractor can act on. */
export function photoEstimateErrorMessage(status: number, serverError?: string | null): string {
  if (serverError) return serverError;
  if (status === 413) return 'The photos are too large to send. Remove a photo or two and try again.';
  if (status === 504 || status === 524) return 'The AI took too long. Try again with fewer photos.';
  if (status === 401) return 'Please log in again.';
  if (status === 429) return 'Too many requests. Wait a minute and try again.';
  if (status >= 500) return 'The server had a problem building the estimate. Please try again.';
  return `Photo estimate failed (HTTP ${status}).`;
}
