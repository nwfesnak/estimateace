'use client';

import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

export type MileageLog = {
  id: string;
  date: string; // YYYY-MM-DD
  miles: number;
  purpose: string;
  fromLocation: string;
  toLocation: string;
  jobName: string;
  notes: string;
  createdAt: string;
};

export const DEFAULT_MILEAGE_RATE = 0.7;

type MileageTrackerProps = {
  logs: MileageLog[];
  ratePerMile: number;
  onChangeLogs: (logs: MileageLog[]) => void;
  onChangeRate: (rate: number) => void;
  onSave: (logs: MileageLog[], rate: number) => void | Promise<void>;
  saving?: boolean;
  disabled?: boolean;
};

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parseDate(raw: string): Date | null {
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
    const [y, m, d] = raw.slice(0, 10).split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    return isNaN(dt.getTime()) ? null : dt;
  }
  const dt = new Date(raw);
  return isNaN(dt.getTime()) ? null : dt;
}

function formatMoney(n: number): string {
  return `$${n.toFixed(2)}`;
}

function emptyForm() {
  return {
    date: todayISO(),
    miles: '',
    purpose: 'Business — job site / client',
    fromLocation: '',
    toLocation: '',
    jobName: '',
    notes: '',
  };
}

export function MileageTracker({
  logs,
  ratePerMile,
  onChangeLogs,
  onChangeRate,
  onSave,
  saving = false,
  disabled = false,
}: MileageTrackerProps) {
  const [form, setForm] = React.useState(emptyForm);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [yearFilter, setYearFilter] = React.useState<string>('all');
  const [expandedMonths, setExpandedMonths] = React.useState<Record<string, boolean>>({});
  const [rateInput, setRateInput] = React.useState(String(ratePerMile));
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    setRateInput(String(ratePerMile));
  }, [ratePerMile]);

  const rate = Math.max(0, Number(ratePerMile) || 0);

  const years = React.useMemo(() => {
    const set = new Set<number>();
    for (const log of logs) {
      const d = parseDate(log.date);
      if (d) set.add(d.getFullYear());
    }
    return Array.from(set).sort((a, b) => b - a);
  }, [logs]);

  const filteredLogs = React.useMemo(() => {
    if (yearFilter === 'all') return logs;
    const y = Number(yearFilter);
    return logs.filter((l) => {
      const d = parseDate(l.date);
      return d && d.getFullYear() === y;
    });
  }, [logs, yearFilter]);

  const byMonth = React.useMemo(() => {
    type MonthG = {
      key: string;
      label: string;
      year: number;
      logs: MileageLog[];
      miles: number;
      deduction: number;
    };
    const map = new Map<string, MonthG>();
    for (const log of filteredLogs) {
      const d = parseDate(log.date);
      const key = d
        ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
        : 'unknown';
      const label = d
        ? d.toLocaleString('en-US', { month: 'long', year: 'numeric' })
        : 'Unknown date';
      const year = d ? d.getFullYear() : 0;
      if (!map.has(key)) {
        map.set(key, { key, label, year, logs: [], miles: 0, deduction: 0 });
      }
      const g = map.get(key)!;
      const miles = Number(log.miles) || 0;
      g.logs.push(log);
      g.miles += miles;
      g.deduction += miles * rate;
    }
    for (const g of map.values()) {
      g.logs.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    }
    return Array.from(map.values()).sort((a, b) => {
      if (a.key === 'unknown') return 1;
      if (b.key === 'unknown') return -1;
      return b.key.localeCompare(a.key);
    });
  }, [filteredLogs, rate]);

  const totalMiles = filteredLogs.reduce((s, l) => s + (Number(l.miles) || 0), 0);
  const totalDeduction = totalMiles * rate;

  const applyRate = () => {
    const n = parseFloat(rateInput);
    if (!Number.isFinite(n) || n < 0) {
      setError('Enter a valid mileage rate (e.g. 0.70).');
      return;
    }
    onChangeRate(Math.round(n * 10000) / 10000);
    setError(null);
    void onSave(logs, Math.round(n * 10000) / 10000);
  };

  const resetForm = () => {
    setForm(emptyForm());
    setEditingId(null);
    setError(null);
  };

  const startEdit = (log: MileageLog) => {
    setEditingId(log.id);
    setForm({
      date: log.date || todayISO(),
      miles: String(log.miles ?? ''),
      purpose: log.purpose || '',
      fromLocation: log.fromLocation || '',
      toLocation: log.toLocation || '',
      jobName: log.jobName || '',
      notes: log.notes || '',
    });
    setError(null);
  };

  const submitTrip = () => {
    const miles = parseFloat(String(form.miles).replace(/,/g, ''));
    if (!form.date) {
      setError('Date is required.');
      return;
    }
    if (!Number.isFinite(miles) || miles <= 0) {
      setError('Enter miles driven (greater than 0).');
      return;
    }

    const entry: MileageLog = {
      id: editingId || `mi-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      date: form.date.slice(0, 10),
      miles: Math.round(miles * 10) / 10,
      purpose: form.purpose.trim() || 'Business',
      fromLocation: form.fromLocation.trim(),
      toLocation: form.toLocation.trim(),
      jobName: form.jobName.trim(),
      notes: form.notes.trim(),
      createdAt: editingId
        ? logs.find((l) => l.id === editingId)?.createdAt || new Date().toISOString()
        : new Date().toISOString(),
    };

    let next: MileageLog[];
    if (editingId) {
      next = logs.map((l) => (l.id === editingId ? entry : l));
    } else {
      next = [entry, ...logs];
    }
    // newest first
    next = [...next].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    onChangeLogs(next);
    void onSave(next, rate);
    resetForm();
  };

  const deleteTrip = (id: string) => {
    if (typeof window !== 'undefined' && !window.confirm('Delete this mileage entry?')) return;
    const next = logs.filter((l) => l.id !== id);
    onChangeLogs(next);
    void onSave(next, rate);
    if (editingId === id) resetForm();
  };

  const exportCsv = () => {
    let csv =
      'Date,Miles,From,To,Purpose,Job,Notes,Rate Per Mile,Write-Off Amount\n';
    const sorted = [...filteredLogs].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    for (const l of sorted) {
      const miles = Number(l.miles) || 0;
      const amount = miles * rate;
      const esc = (v: string) => `"${String(v || '').replace(/"/g, '""')}"`;
      csv += `${l.date},${miles.toFixed(1)},${esc(l.fromLocation)},${esc(l.toLocation)},${esc(l.purpose)},${esc(l.jobName)},${esc(l.notes)},${rate.toFixed(4)},${amount.toFixed(2)}\n`;
    }
    csv += `\nTotal Miles,${totalMiles.toFixed(1)}\n`;
    csv += `Rate Per Mile,${rate.toFixed(4)}\n`;
    csv += `Total Gas Write-Off,${totalDeduction.toFixed(2)}\n`;

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Mileage_Log_${yearFilter === 'all' ? 'All' : yearFilter}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-8">
      <div>
        <h3 className="text-xl font-semibold text-[#1e293b]">🚗 Mileage log (gas write-off)</h3>
        <p className="text-sm text-gray-500 mt-1">
          Track business miles for tax deductions. Log each trip, set your rate per mile, and export a
          CSV for your accountant. Keep receipts / a consistent method for IRS records.
        </p>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card>
          <CardContent className="p-5 text-center">
            <div className="text-xs uppercase tracking-wide text-gray-500">Miles (filter)</div>
            <div className="text-3xl font-bold text-[#1e293b] mt-1">{totalMiles.toFixed(1)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-5 text-center">
            <div className="text-xs uppercase tracking-wide text-gray-500">Rate / mile</div>
            <div className="text-3xl font-bold text-[#14b8a6] mt-1">{formatMoney(rate)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-5 text-center">
            <div className="text-xs uppercase tracking-wide text-gray-500">Write-off amount</div>
            <div className="text-3xl font-bold text-[#10b981] mt-1">{formatMoney(totalDeduction)}</div>
          </CardContent>
        </Card>
      </div>

      {/* Rate + filters */}
      <div className="flex flex-wrap items-end gap-3 bg-white border rounded-2xl p-4">
        <div className="w-36">
          <label className="block text-xs font-medium text-gray-500 mb-1">$/mile rate</label>
          <Input
            type="number"
            step="0.01"
            min="0"
            value={rateInput}
            disabled={disabled}
            onChange={(e) => setRateInput(e.target.value)}
            className="bg-white"
          />
        </div>
        <Button type="button" variant="outline" onClick={applyRate} disabled={disabled || saving}>
          Save rate
        </Button>
        <div className="w-36">
          <label className="block text-xs font-medium text-gray-500 mb-1">Year</label>
          <select
            value={yearFilter}
            onChange={(e) => setYearFilter(e.target.value)}
            className="flex h-10 w-full rounded-lg border border-input bg-white px-3 text-sm"
          >
            <option value="all">All years</option>
            {years.map((y) => (
              <option key={y} value={String(y)}>
                {y}
              </option>
            ))}
          </select>
        </div>
        <Button
          type="button"
          className="bg-[#10b981] hover:bg-[#059669] text-white ml-auto"
          onClick={exportCsv}
          disabled={filteredLogs.length === 0}
        >
          Export CSV
        </Button>
      </div>

      {/* Add / edit form */}
      <div className="bg-white border rounded-2xl p-5 space-y-4">
        <h4 className="font-semibold text-[#1e293b]">
          {editingId ? 'Edit trip' : 'Log a trip'}
        </h4>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Date *</label>
            <Input
              type="date"
              value={form.date}
              disabled={disabled}
              onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Miles *</label>
            <Input
              type="number"
              min="0"
              step="0.1"
              placeholder="e.g. 24.5"
              value={form.miles}
              disabled={disabled}
              onChange={(e) => setForm((f) => ({ ...f, miles: e.target.value }))}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Purpose</label>
            <Input
              value={form.purpose}
              disabled={disabled}
              onChange={(e) => setForm((f) => ({ ...f, purpose: e.target.value }))}
              placeholder="Business — job site"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">From</label>
            <Input
              value={form.fromLocation}
              disabled={disabled}
              onChange={(e) => setForm((f) => ({ ...f, fromLocation: e.target.value }))}
              placeholder="Home / shop"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">To</label>
            <Input
              value={form.toLocation}
              disabled={disabled}
              onChange={(e) => setForm((f) => ({ ...f, toLocation: e.target.value }))}
              placeholder="Job address"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Job / client</label>
            <Input
              value={form.jobName}
              disabled={disabled}
              onChange={(e) => setForm((f) => ({ ...f, jobName: e.target.value }))}
              placeholder="Optional"
            />
          </div>
          <div className="sm:col-span-2 lg:col-span-3">
            <label className="block text-xs font-medium text-gray-500 mb-1">Notes</label>
            <Input
              value={form.notes}
              disabled={disabled}
              onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
              placeholder="Optional (round trip, supplies run, etc.)"
            />
          </div>
        </div>
        {error && <p className="text-sm text-amber-700">{error}</p>}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            className="bg-[#10b981] hover:bg-[#059669] text-white"
            onClick={submitTrip}
            disabled={disabled || saving}
          >
            {editingId ? 'Update trip' : 'Add trip'}
          </Button>
          {editingId && (
            <Button type="button" variant="outline" onClick={resetForm}>
              Cancel edit
            </Button>
          )}
        </div>
      </div>

      {/* Monthly log */}
      <div>
        <h4 className="font-semibold text-[#1e293b] mb-3">Log by month</h4>
        {byMonth.length === 0 ? (
          <div className="rounded-xl border border-dashed border-gray-300 bg-gray-50 p-8 text-center text-gray-500">
            No trips logged yet. Add your first business trip above.
          </div>
        ) : (
          <div className="space-y-3">
            {byMonth.map((month) => {
              const open = !!expandedMonths[month.key];
              return (
                <div
                  key={month.key}
                  className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-sm"
                >
                  <button
                    type="button"
                    onClick={() =>
                      setExpandedMonths((prev) => ({ ...prev, [month.key]: !prev[month.key] }))
                    }
                    className="w-full flex flex-wrap items-center justify-between gap-2 px-4 py-4 text-left hover:bg-slate-50"
                  >
                    <div className="flex items-center gap-3">
                      <span className="text-gray-400 w-5">{open ? '▼' : '▶'}</span>
                      <div>
                        <div className="font-semibold text-lg">{month.label}</div>
                        <div className="text-xs text-gray-500">
                          {month.logs.length} trip{month.logs.length === 1 ? '' : 's'}
                        </div>
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="font-bold text-[#10b981]">{month.miles.toFixed(1)} mi</div>
                      <div className="text-xs text-gray-500">{formatMoney(month.deduction)} write-off</div>
                    </div>
                  </button>
                  {open && (
                    <div className="border-t overflow-x-auto">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Date</TableHead>
                            <TableHead className="text-right">Miles</TableHead>
                            <TableHead>Route</TableHead>
                            <TableHead>Purpose / job</TableHead>
                            <TableHead className="text-right">Write-off</TableHead>
                            <TableHead className="text-right">Actions</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {month.logs.map((log) => {
                            const miles = Number(log.miles) || 0;
                            const route =
                              [log.fromLocation, log.toLocation].filter(Boolean).join(' → ') || '—';
                            return (
                              <TableRow key={log.id}>
                                <TableCell className="whitespace-nowrap text-sm">{log.date}</TableCell>
                                <TableCell className="text-right font-semibold whitespace-nowrap">
                                  {miles.toFixed(1)}
                                </TableCell>
                                <TableCell className="text-sm max-w-[10rem] truncate" title={route}>
                                  {route}
                                </TableCell>
                                <TableCell className="text-sm">
                                  <div className="truncate max-w-[12rem]" title={log.purpose}>
                                    {log.purpose || '—'}
                                  </div>
                                  {log.jobName ? (
                                    <div className="text-xs text-gray-400 truncate">{log.jobName}</div>
                                  ) : null}
                                </TableCell>
                                <TableCell className="text-right whitespace-nowrap">
                                  {formatMoney(miles * rate)}
                                </TableCell>
                                <TableCell className="text-right whitespace-nowrap">
                                  <button
                                    type="button"
                                    className="text-xs text-emerald-700 font-semibold mr-2"
                                    onClick={() => startEdit(log)}
                                    disabled={disabled}
                                  >
                                    Edit
                                  </button>
                                  <button
                                    type="button"
                                    className="text-xs text-red-600 font-semibold"
                                    onClick={() => deleteTrip(log.id)}
                                    disabled={disabled}
                                  >
                                    Delete
                                  </button>
                                </TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <p className="text-xs text-gray-400 leading-snug">
        Tip: The IRS standard mileage rate changes yearly — set your rate above to match the current
        published rate (or your actual-cost method if you use that). This log is for your records; it
        is not tax advice.
      </p>
    </div>
  );
}

/** Normalize raw JSON from SETTINGS profile into MileageLog[] */
export function normalizeMileageLogs(raw: unknown): MileageLog[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((row: any, i: number) => {
      if (!row || typeof row !== 'object') return null;
      const miles = Number(row.miles);
      if (!Number.isFinite(miles) || miles <= 0) return null;
      return {
        id: String(row.id || `mi-legacy-${i}`),
        date: String(row.date || '').slice(0, 10) || todayISO(),
        miles: Math.round(miles * 10) / 10,
        purpose: String(row.purpose || ''),
        fromLocation: String(row.fromLocation || row.from || ''),
        toLocation: String(row.toLocation || row.to || ''),
        jobName: String(row.jobName || ''),
        notes: String(row.notes || ''),
        createdAt: String(row.createdAt || row.created_at || new Date().toISOString()),
      } as MileageLog;
    })
    .filter(Boolean) as MileageLog[];
}
