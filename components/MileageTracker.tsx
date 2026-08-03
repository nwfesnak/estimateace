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
  /** Persist logs (and optional rate). Job mode only needs logs. */
  onSave: (logs: MileageLog[], rate: number) => void | Promise<void>;
  onChangeRate?: (rate: number) => void;
  saving?: boolean;
  disabled?: boolean;
  /** job = compact UI under estimate receipts; full = profile-style overview */
  variant?: 'job' | 'full';
  /** Pre-fill job name on new trips */
  defaultJobName?: string;
  title?: string;
  /** Profile summary only: hide add form, show totals + optional rate */
  summaryOnly?: boolean;
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

function emptyForm(defaultJobName = '') {
  return {
    date: todayISO(),
    miles: '',
    purpose: 'Business — job site / client',
    fromLocation: '',
    toLocation: '',
    jobName: defaultJobName,
    notes: '',
  };
}

export function sumMileageLogs(logs: MileageLog[]): number {
  return (logs || []).reduce((s, l) => s + (Number(l.miles) || 0), 0);
}

/** Normalize raw JSON into MileageLog[] */
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

/** Pull job miles from an estimate/invoice/archive row */
export function mileageLogsFromDoc(doc: any): MileageLog[] {
  if (!doc) return [];
  const fromProfile = doc.profile?._mileageLogs ?? doc.profile?.jobMileageLogs;
  return normalizeMileageLogs(doc.mileageLogs ?? fromProfile ?? []);
}

export function MileageTracker({
  logs,
  ratePerMile,
  onChangeLogs,
  onSave,
  onChangeRate,
  saving = false,
  disabled = false,
  variant = 'full',
  defaultJobName = '',
  title,
  summaryOnly = false,
}: MileageTrackerProps) {
  const isJob = variant === 'job';
  const [form, setForm] = React.useState(() => emptyForm(defaultJobName));
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [rateInput, setRateInput] = React.useState(String(ratePerMile));
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    setRateInput(String(ratePerMile));
  }, [ratePerMile]);

  React.useEffect(() => {
    if (!editingId) {
      setForm((f) => ({ ...f, jobName: f.jobName || defaultJobName }));
    }
  }, [defaultJobName, editingId]);

  const rate = Math.max(0, Number(ratePerMile) || 0);
  const totalMiles = sumMileageLogs(logs);
  const totalDeduction = totalMiles * rate;

  const applyRate = () => {
    if (!onChangeRate) return;
    const n = parseFloat(rateInput);
    if (!Number.isFinite(n) || n < 0) {
      setError('Enter a valid mileage rate (e.g. 0.70).');
      return;
    }
    const next = Math.round(n * 10000) / 10000;
    onChangeRate(next);
    setError(null);
    void onSave(logs, next);
  };

  const resetForm = () => {
    setForm(emptyForm(defaultJobName));
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
      jobName: log.jobName || defaultJobName,
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
      jobName: (form.jobName || defaultJobName).trim(),
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
    let csv = 'Date,Miles,From,To,Purpose,Job,Notes,Rate Per Mile,Write-Off Amount\n';
    const sorted = [...logs].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
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
    a.download = `Mileage_${defaultJobName || 'log'}.csv`.replace(/[^\w.\-]+/g, '_');
    a.click();
    URL.revokeObjectURL(url);
  };

  if (summaryOnly) {
    return (
      <div className="space-y-4">
        <div>
          <h3 className="text-xl font-semibold text-[#1e293b]">
            {title || '🚗 Total business miles'}
          </h3>
          <p className="text-sm text-gray-500 mt-1">
            Sum of miles logged on all jobs (estimates &amp; invoices) for profit / tax write-off.
            Log trips on each job with the <strong>Mileage</strong> button next to Labor.
          </p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Card>
            <CardContent className="p-5 text-center">
              <div className="text-xs uppercase tracking-wide text-gray-500">Total miles</div>
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
        {onChangeRate && (
          <div className="flex flex-wrap items-end gap-3 bg-slate-50 border rounded-xl p-4">
            <div className="w-36">
              <label className="block text-xs font-medium text-gray-500 mb-1">$/mile rate</label>
              <Input
                type="number"
                step="0.01"
                min="0"
                value={rateInput}
                disabled={disabled}
                onChange={(e) => setRateInput(e.target.value)}
              />
            </div>
            <Button type="button" variant="outline" onClick={applyRate} disabled={disabled || saving}>
              Save rate
            </Button>
            <Button
              type="button"
              className="bg-[#10b981] text-white ml-auto"
              onClick={exportCsv}
              disabled={logs.length === 0}
            >
              Export all CSV
            </Button>
          </div>
        )}
        <p className="text-xs text-gray-400">
          Log miles on each estimate with the <strong>Mileage</strong> button (next to Labor). This total updates from all saved jobs.
        </p>
      </div>
    );
  }

  return (
    <div className={isJob ? 'space-y-4' : 'space-y-8'}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className={`${isJob ? 'text-lg' : 'text-xl'} font-semibold text-[#1e293b]`}>
            {title || (isJob ? '🚗 Job mileage (gas write-off)' : '🚗 Mileage log')}
          </h3>
          {!isJob && (
            <p className="text-sm text-gray-500 mt-1">
              Track business miles for tax deductions.
            </p>
          )}
          {isJob && !title && (
            <p className="text-sm text-gray-500 mt-1">
              Miles for this job only — saved with the estimate/invoice.
            </p>
          )}
        </div>
        <div className="text-right shrink-0">
          <div className="text-xs text-gray-500">This job</div>
          <div className="text-lg font-bold text-[#10b981]">
            {totalMiles.toFixed(1)} mi
            <span className="text-sm font-medium text-gray-500 ml-2">
              ({formatMoney(totalDeduction)})
            </span>
          </div>
        </div>
      </div>

      {/* Add / edit form */}
      <div className={`rounded-xl border p-4 space-y-3 ${isJob ? 'bg-slate-50 border-slate-200' : 'bg-white'}`}>
        <h4 className="font-semibold text-sm text-[#1e293b]">
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
              className="bg-white"
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
              className="bg-white"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Purpose</label>
            <Input
              value={form.purpose}
              disabled={disabled}
              onChange={(e) => setForm((f) => ({ ...f, purpose: e.target.value }))}
              className="bg-white"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">From</label>
            <Input
              value={form.fromLocation}
              disabled={disabled}
              onChange={(e) => setForm((f) => ({ ...f, fromLocation: e.target.value }))}
              placeholder="Home / shop"
              className="bg-white"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">To</label>
            <Input
              value={form.toLocation}
              disabled={disabled}
              onChange={(e) => setForm((f) => ({ ...f, toLocation: e.target.value }))}
              placeholder="Job site"
              className="bg-white"
            />
          </div>
          {!isJob && (
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Job / client</label>
              <Input
                value={form.jobName}
                disabled={disabled}
                onChange={(e) => setForm((f) => ({ ...f, jobName: e.target.value }))}
                className="bg-white"
              />
            </div>
          )}
          <div className={isJob ? 'sm:col-span-2 lg:col-span-3' : 'sm:col-span-2 lg:col-span-3'}>
            <label className="block text-xs font-medium text-gray-500 mb-1">Notes</label>
            <Input
              value={form.notes}
              disabled={disabled}
              onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
              placeholder="Optional"
              className="bg-white"
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
              Cancel
            </Button>
          )}
          {logs.length > 0 && (
            <Button type="button" variant="outline" className="ml-auto" onClick={exportCsv}>
              Export CSV
            </Button>
          )}
        </div>
      </div>

      {/* Trip list */}
      {logs.length === 0 ? (
        <p className="text-sm text-gray-500 text-center py-2">No miles logged on this job yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border bg-white">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead className="text-right">Miles</TableHead>
                <TableHead>Route</TableHead>
                <TableHead>Purpose</TableHead>
                <TableHead className="text-right">Write-off</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {logs.map((log) => {
                const miles = Number(log.miles) || 0;
                const route =
                  [log.fromLocation, log.toLocation].filter(Boolean).join(' → ') || '—';
                return (
                  <TableRow key={log.id}>
                    <TableCell className="whitespace-nowrap text-sm">{log.date}</TableCell>
                    <TableCell className="text-right font-semibold">{miles.toFixed(1)}</TableCell>
                    <TableCell className="text-sm max-w-[9rem] truncate" title={route}>
                      {route}
                    </TableCell>
                    <TableCell className="text-sm max-w-[8rem] truncate" title={log.purpose}>
                      {log.purpose || '—'}
                    </TableCell>
                    <TableCell className="text-right text-sm whitespace-nowrap">
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

      <p className="text-[10px] text-gray-400 leading-snug">
        Rate used for write-off: {formatMoney(rate)}/mi (change in Profile). Not tax advice.
      </p>
    </div>
  );
}
