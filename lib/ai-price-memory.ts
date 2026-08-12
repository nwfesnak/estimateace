/**
 * Remember contractor-edited material unit prices and labor rates so the next
 * AI quote reuses those values (e.g. labor $67 → $150 implies a new $/hr).
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
  /**
   * Optional last labor total the contractor accepted (full job $).
   * Used as a soft floor when similar scope is short on hours.
   */
  laborTotalHint?: number;
  laborHoursHint?: number;
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
  const laborTotalHint = roundMoney(o.laborTotalHint);
  const laborHoursHint = roundMoney(o.laborHoursHint);
  return {
    materials: materials.slice(0, MAX_MATERIALS),
    laborRate: laborRate > 0 ? laborRate : undefined,
    laborDescription: o.laborDescription ? String(o.laborDescription) : undefined,
    laborUpdatedAt: o.laborUpdatedAt ? String(o.laborUpdatedAt) : undefined,
    laborTotalHint: laborTotalHint > 0 ? laborTotalHint : undefined,
    laborHoursHint: laborHoursHint > 0 ? laborHoursHint : undefined,
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
  if (key.length < 4) return null;
  const fuzzy = memory.materials.find(
    (m) =>
      (m.key.includes(key) || key.includes(m.key)) &&
      Math.min(m.key.length, key.length) >= 4
  );
  return fuzzy || null;
}

/** Learn from a user-saved breakdown edit (materials + labor). */
export function learnFromBreakdownEdit(
  previous: AiPriceMemory | null | undefined,
  materials: Array<{
    description?: string;
    unitPrice?: number;
    unit?: string;
    qty?: number;
    total?: number;
  }>,
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
  let laborTotalHint = mem.laborTotalHint;
  let laborHoursHint = mem.laborHoursHint;

  if (labor) {
    const hours = Number(labor.hours) || 0;
    const total = roundMoney(Number(labor.total) || 0);
    let rate = roundMoney(Number(labor.rate) || 0);
    if (rate <= 0 && hours > 0 && total > 0) {
      rate = roundMoney(total / hours);
    }
    // Accept real contractor rates (was capped too tightly before)
    if (rate >= 10 && rate <= 500) {
      laborRate = rate;
      laborDescription = String(labor.description || laborDescription || 'Labor').trim();
      laborUpdatedAt = now;
    }
    if (total > 0) {
      laborTotalHint = total;
      laborHoursHint = hours > 0 ? hours : laborHoursHint;
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
    laborTotalHint,
    laborHoursHint,
  };
}

/**
 * Learn from a line-item unit price / total edit (not only breakdown editor).
 * If the line has a labor breakdown, derive rate from labor total ÷ hours after scale.
 */
export function learnFromLinePriceEdit(
  previous: AiPriceMemory | null | undefined,
  options: {
    materials?: Array<{
      description?: string;
      unitPrice?: number;
      unit?: string;
      qty?: number;
      total?: number;
    }>;
    labor?: { description?: string; rate?: number; hours?: number; total?: number } | null;
    /** Full line total the contractor set */
    lineTotal?: number;
  }
): AiPriceMemory {
  let mem = learnFromBreakdownEdit(
    previous,
    options.materials || [],
    options.labor || null
  );

  // If labor total/rate still empty but line total was raised a lot, store soft hint
  const lineTotal = roundMoney(Number(options.lineTotal) || 0);
  if (lineTotal > 0 && !options.labor?.total) {
    const now = new Date().toISOString();
    mem = {
      ...mem,
      laborTotalHint: lineTotal,
      laborUpdatedAt: now,
    };
  }

  return mem;
}

/**
 * Overlay remembered prices onto an AI breakdown.
 * Rebuilds material totals and labor total from qty/hours × preferred rate.
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
      total: roundMoney(hours > 0 ? hours * rate : Number(labor.total) || 0),
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
  if (!mem.materials.length && !mem.laborRate && !mem.laborTotalHint) return '';

  const lines: string[] = [
    'CONTRACTOR PREFERRED PRICES (from their prior edits — MUST use these when applicable):',
  ];
  if (mem.laborRate) {
    lines.push(
      `- Labor hourly rate: $${mem.laborRate.toFixed(2)}/hr${
        mem.laborDescription ? ` (${mem.laborDescription})` : ''
      } — use this rate for laborBreakdown.rate on every quote unless the job is a different trade specialty.`
    );
  }
  if (mem.laborTotalHint && mem.laborHoursHint) {
    lines.push(
      `- Last accepted labor package: $${mem.laborTotalHint.toFixed(2)} for ~${mem.laborHoursHint} hrs (implies ~$${(
        mem.laborTotalHint / mem.laborHoursHint
      ).toFixed(2)}/hr).`
    );
  }
  const top = mem.materials.slice(0, 40);
  for (const m of top) {
    lines.push(
      `- Material "${m.label}": $${m.unitPrice.toFixed(2)}${
        m.unit ? ` per ${m.unit}` : ' unit price'
      }`
    );
  }
  lines.push(
    'When materials match these names, use the preferred unitPrice. Always use the preferred labor rate when set. Still estimate realistic qty/hours for THIS job.'
  );
  return lines.join('\n');
}

/** True if two memory objects are effectively the same (avoid extra saves). */
export function aiPriceMemoryEquals(a: AiPriceMemory | null | undefined, b: AiPriceMemory | null | undefined): boolean {
  const na = normalizeAiPriceMemory(a);
  const nb = normalizeAiPriceMemory(b);
  return JSON.stringify(na) === JSON.stringify(nb);
}
