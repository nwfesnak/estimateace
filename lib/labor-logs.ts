/**
 * Per-job labor entries (hours × rate + memo for whom was paid).
 * Stored on the document profile as `_laborLogs`.
 */

export type LaborLog = {
  id: string;
  hours: number;
  rate: number;
  /** Note for whom / what the labor payment was for */
  memo: string;
  total: number;
  createdAt: string;
};

const roundMoney = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

export function normalizeLaborLogs(raw: unknown): LaborLog[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((row: any, i: number) => {
      if (!row || typeof row !== 'object') return null;
      const hours = Math.max(0, Number(row.hours) || 0);
      const rate = Math.max(0, Number(row.rate) || 0);
      const total =
        Number(row.total) > 0 ? roundMoney(Number(row.total)) : roundMoney(hours * rate);
      if (hours <= 0 && total <= 0) return null;
      return {
        id: String(row.id || `labor-${i}-${Date.now()}`),
        hours,
        rate,
        memo: String(row.memo || row.note || row.paidTo || '').trim(),
        total,
        createdAt: String(row.createdAt || new Date().toISOString()),
      } as LaborLog;
    })
    .filter(Boolean) as LaborLog[];
}

export function sumLaborLogs(logs: LaborLog[]): number {
  return roundMoney((logs || []).reduce((s, l) => s + (Number(l.total) || 0), 0));
}

export function sumLaborHours(logs: LaborLog[]): number {
  return Math.round((logs || []).reduce((s, l) => s + (Number(l.hours) || 0), 0) * 100) / 100;
}

/** Read labor logs from a saved estimate/invoice row (with legacy single-labor fallback). */
export function laborLogsFromDoc(doc: any): LaborLog[] {
  if (!doc) return [];
  const fromProfile = doc.profile?._laborLogs ?? doc.profile?.laborLogs ?? doc.laborLogs;
  const normalized = normalizeLaborLogs(fromProfile);
  if (normalized.length > 0) return normalized;

  // Legacy: single laborHours × laborRate (or fixed amount)
  const hours = Number(doc.laborHours ?? doc.laborhours) || 0;
  const rate = Number(doc.laborRate ?? doc.laborrate) || 0;
  const fixed = Number(doc.laborFixedAmount ?? doc.laborfixedamount) || 0;
  const useHourly = doc.useHourlyLabor ?? doc.usehourlylabor;
  const amount =
    Number(doc.laborAmount ?? doc.laboramount) ||
    (useHourly === false ? fixed : hours * rate);
  if (!(amount > 0) && !(hours > 0)) return [];
  return [
    {
      id: `legacy-labor-${doc.id || 'doc'}`,
      hours: useHourly === false ? 0 : hours,
      rate: useHourly === false ? 0 : rate,
      memo: useHourly === false ? 'Fixed labor (legacy)' : '',
      total: roundMoney(amount),
      createdAt: String(doc.updated_at || doc.date || new Date().toISOString()),
    },
  ];
}
