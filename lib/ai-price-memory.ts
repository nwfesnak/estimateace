/**
 * Remember contractor-edited material unit prices and labor rates so the next
 * AI quote breakdown reuses those values instead of reinventing them.
 */

export type MaterialPriceMemory = {
  key: string;
  label: string;
  unitPrice: number;
  unit?: string;
  updatedAt: string;
};

export type AiPriceMemory = {
  materials: MaterialPriceMemory[];
  /** Preferred hourly labor rate from last user edit */
  laborRate?: number;
  laborDescription?: string;
  laborUpdatedAt?: string;
};

export type MemoryMaterialLine = {
  description: string;
  qty: number;
  unit: string;
  unitPrice: number;
  total: number;
};

export type MemoryLaborLine = {
  description: string;
  hours: number;
  rate: number;
  total: number;
};

const MAX_MATERIALS = 120;
const roundMoney = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

export function normalizeMaterialKey(description: string): string {
  return String(description || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b(ea|each|gal|gallon|s|sf|sqft|lf|hr|hrs|hour|hours)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 96);
}

export function normalizeAiPriceMemory(raw: unknown): AiPriceMemory {
  if (!raw || typeof raw !== 'object') return { materials: [] };
  const o = raw as any;
  const materials: MaterialPriceMemory[] = [];
  const list = Array.isArray(o.materials) ? o.materials : [];
  for (const row of list) {
    if (!row || typeof row !== 'object') continue;
    const key = String(row.key || normalizeMaterialKey(row.label || row.description || '')).trim();
    const unitPrice = roundMoney(row.unitPrice);
    if (!key || unitPrice <= 0) continue;
    materials.push({
      key,
      label: String(row.label || row.description || key).trim(),
      unitPrice,
      unit: String(row.unit || '').trim() || undefined,
      updatedAt: String(row.updatedAt || new Date().toISOString()),
    });
  }
  const laborRate = roundMoney(o.laborRate);
  return {
    materials: materials.slice(0, MAX_MATERIALS),
    laborRate: laborRate > 0 ? laborRate : undefined,
    laborDescription: o.laborDescription ? String(o.laborDescription) : undefined,
    laborUpdatedAt: o.laborUpdatedAt ? String(o.laborUpdatedAt) : undefined,
  };
}

function findMaterialMemory(
  memory: AiPriceMemory,
  description: string
): MaterialPriceMemory | null {
  const key = normalizeMaterialKey(description);
  if (!key) return null;
  const exact = memory.materials.find((m) => m.key === key);
  if (exact) return exact;
  // Partial: either key contains the other (min length 4)
  if (key.length < 4) return null;
  const fuzzy = memory.materials.find(
    (m) =>
      (m.key.includes(key) || key.includes(m.key)) &&
      Math.min(m.key.length, key.length) >= 4
  );
  return fuzzy || null;
}

/** Learn from a user-saved breakdown edit. */
export function learnFromBreakdownEdit(
  previous: AiPriceMemory | null | undefined,
  materials: Array<{ description?: string; unitPrice?: number; unit?: string; qty?: number; total?: number }>,
  labor: { description?: string; rate?: number; hours?: number; total?: number } | null
): AiPriceMemory {
  const mem = normalizeAiPriceMemory(previous);
  const now = new Date().toISOString();
  const byKey = new Map(mem.materials.map((m) => [m.key, m]));

  for (const m of materials || []) {
    const label = String(m.description || '').trim();
    const key = normalizeMaterialKey(label);
    let unitPrice = roundMoney(Number(m.unitPrice) || 0);
    if (unitPrice <= 0 && Number(m.qty) > 0 && Number(m.total) > 0) {
      unitPrice = roundMoney(Number(m.total) / Number(m.qty));
    }
    if (!key || unitPrice <= 0) continue;
    byKey.set(key, {
      key,
      label: label || key,
      unitPrice,
      unit: String(m.unit || '').trim() || undefined,
      updatedAt: now,
    });
  }

  let laborRate = mem.laborRate;
  let laborDescription = mem.laborDescription;
  let laborUpdatedAt = mem.laborUpdatedAt;
  if (labor) {
    let rate = roundMoney(Number(labor.rate) || 0);
    if (rate <= 0 && Number(labor.hours) > 0 && Number(labor.total) > 0) {
      rate = roundMoney(Number(labor.total) / Number(labor.hours));
    }
    // Ignore nonsense rates
    if (rate >= 15 && rate <= 400) {
      laborRate = rate;
      laborDescription = String(labor.description || laborDescription || 'Labor').trim();
      laborUpdatedAt = now;
    }
  }

  const materialsList = Array.from(byKey.values())
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    .slice(0, MAX_MATERIALS);

  return {
    materials: materialsList,
    laborRate,
    laborDescription,
    laborUpdatedAt,
  };
}

/**
 * Overlay remembered prices onto an AI (or deterministic) breakdown.
 * Rebuilds material totals and labor total from qty/hours.
 */
export function applyPriceMemoryToBreakdown(
  materials: MemoryMaterialLine[],
  labor: MemoryLaborLine | null,
  memory: AiPriceMemory | null | undefined
): {
  materials: MemoryMaterialLine[];
  labor: MemoryLaborLine | null;
  appliedMaterialCount: number;
  appliedLaborRate: boolean;
} {
  const mem = normalizeAiPriceMemory(memory);
  let appliedMaterialCount = 0;
  let appliedLaborRate = false;

  const nextMaterials = (materials || []).map((m) => {
    const learned = findMaterialMemory(mem, m.description);
    if (!learned || learned.unitPrice <= 0) return m;
    const qty = Number(m.qty) || 0;
    const unitPrice = learned.unitPrice;
    appliedMaterialCount += 1;
    return {
      ...m,
      unitPrice,
      unit: m.unit || learned.unit || m.unit,
      total: roundMoney(qty > 0 ? qty * unitPrice : unitPrice),
    };
  });

  let nextLabor = labor;
  if (labor && mem.laborRate && mem.laborRate > 0) {
    const hours = Number(labor.hours) || 0;
    const rate = mem.laborRate;
    nextLabor = {
      ...labor,
      rate,
      total: roundMoney(hours > 0 ? hours * rate : labor.total),
    };
    appliedLaborRate = true;
  }

  return {
    materials: nextMaterials,
    labor: nextLabor,
    appliedMaterialCount,
    appliedLaborRate,
  };
}

/** Compact list for the AI system prompt */
export function formatPriceMemoryForPrompt(memory: AiPriceMemory | null | undefined): string {
  const mem = normalizeAiPriceMemory(memory);
  if (!mem.materials.length && !mem.laborRate) return '';

  const lines: string[] = [
    'CONTRACTOR PREFERRED PRICES (from their prior edits — use these unit prices / rates when the item matches):',
  ];
  if (mem.laborRate) {
    lines.push(
      `- Labor hourly rate: $${mem.laborRate.toFixed(2)}/hr${mem.laborDescription ? ` (${mem.laborDescription})` : ''}`
    );
  }
  const top = mem.materials.slice(0, 40);
  for (const m of top) {
    lines.push(
      `- Material "${m.label}": $${m.unitPrice.toFixed(2)}${m.unit ? ` per ${m.unit}` : ' unit price'}`
    );
  }
  lines.push(
    'When a line matches these names (same product/trade), use the preferred unitPrice or labor rate. Still estimate realistic qty/hours for THIS job.'
  );
  return lines.join('\n');
}
