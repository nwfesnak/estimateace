'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  emptyVendorDraft,
  formatVendorOptionLabel,
  normalizeCompanyVendors,
  shouldSaveNewVendor,
  vendorRowForWrite,
  vendorSnapshotFromDraft,
  vendorToDraft,
  type CompanyVendor,
  type LaborVendorDraft,
  type LaborVendorSnapshot,
} from '@/lib/company-vendors';

type LaborVendorPickerProps = {
  vendors: CompanyVendor[];
  draft: LaborVendorDraft;
  saveVendor: boolean;
  canManage: boolean;
  disabled?: boolean;
  saving?: boolean;
  onDraftChange: (draft: LaborVendorDraft) => void;
  onSaveVendorChange: (save: boolean) => void;
  onPickVendor: (vendor: CompanyVendor | null) => void;
  onVendorsChange: (vendors: CompanyVendor[]) => void;
  persistVendor: (row: Record<string, unknown>, mode: 'insert' | 'update', id?: string) => Promise<CompanyVendor | null>;
  deleteVendor: (id: string) => Promise<boolean>;
  currentRate: number;
  onMessage?: (msg: string) => void;
};

export function LaborVendorPicker({
  vendors,
  draft,
  saveVendor,
  canManage,
  disabled,
  saving,
  onDraftChange,
  onSaveVendorChange,
  onPickVendor,
  onVendorsChange,
  persistVendor,
  deleteVendor,
  currentRate,
  onMessage,
}: LaborVendorPickerProps) {
  const busy = Boolean(disabled || saving);
  const selected = vendors.find((v) => v.id === draft.vendorId) || null;
  const isNew = !draft.vendorId;

  const patch = (partial: Partial<LaborVendorDraft>) => {
    onDraftChange({ ...draft, ...partial });
  };

  const handleSelect = (id: string) => {
    if (!id) {
      onDraftChange(emptyVendorDraft());
      onSaveVendorChange(false);
      onPickVendor(null);
      return;
    }
    const vendor = vendors.find((v) => v.id === id);
    if (!vendor) return;
    onDraftChange(vendorToDraft(vendor));
    onSaveVendorChange(false);
    onPickVendor(vendor);
  };

  const handleUpdateSaved = async () => {
    if (!canManage || !selected) return;
    const name = draft.name.trim();
    if (!name) {
      onMessage?.('Enter a vendor name before updating the saved vendor.');
      return;
    }
    const updated = await persistVendor(
      vendorRowForWrite(selected.companyId, draft, currentRate || null),
      'update',
      selected.id
    );
    if (!updated) {
      onMessage?.('Could not update the saved vendor.');
      return;
    }
    onVendorsChange(normalizeCompanyVendors(vendors.map((v) => (v.id === updated.id ? updated : v))));
    onDraftChange(vendorToDraft(updated));
    onMessage?.(`Saved vendor updated: ${updated.name}`);
  };

  const handleDeleteSaved = async () => {
    if (!canManage || !selected) return;
    if (!confirm(`Remove “${selected.name}” from your saved vendors? Labor already logged on jobs is not deleted.`)) {
      return;
    }
    const ok = await deleteVendor(selected.id);
    if (!ok) {
      onMessage?.('Could not delete the saved vendor.');
      return;
    }
    onVendorsChange(vendors.filter((v) => v.id !== selected.id));
    onDraftChange(emptyVendorDraft());
    onSaveVendorChange(false);
    onPickVendor(null);
    onMessage?.('Saved vendor removed.');
  };

  return (
    <div className="space-y-3" data-testid="labor-vendor-picker">
      <div>
        <label htmlFor="labor-saved-vendor" className="block text-sm font-semibold mb-1">
          Saved vendors
        </label>
        <select
          id="labor-saved-vendor"
          data-testid="labor-saved-vendor-select"
          className="h-11 w-full min-w-0 rounded-lg border border-input bg-white px-2.5 text-base"
          value={draft.vendorId}
          disabled={busy}
          onChange={(e) => handleSelect(e.target.value)}
        >
          <option value="">Add a new vendor</option>
          {vendors.map((vendor) => (
            <option key={vendor.id} value={vendor.id}>
              {formatVendorOptionLabel(vendor)}
            </option>
          ))}
        </select>
        <p className="text-[11px] text-gray-500 mt-1">
          Pick a saved vendor to fill these fields, or enter someone new for this job only.
        </p>
      </div>

      <div className="grid grid-cols-1 min-[400px]:grid-cols-2 gap-3">
        <div className="min-[400px]:col-span-2">
          <label htmlFor="labor-vendor-name" className="block text-sm font-semibold mb-1">
            Vendor name
          </label>
          <Input
            id="labor-vendor-name"
            data-testid="labor-vendor-name"
            className="h-11 text-base"
            type="text"
            autoComplete="organization"
            value={draft.name}
            disabled={busy}
            onChange={(e) => patch({ name: e.target.value })}
            placeholder="e.g. John — framing"
          />
        </div>
        <div>
          <label htmlFor="labor-vendor-trade" className="block text-sm font-semibold mb-1">
            Trade
          </label>
          <Input
            id="labor-vendor-trade"
            data-testid="labor-vendor-trade"
            className="h-11 text-base"
            type="text"
            value={draft.trade}
            disabled={busy}
            onChange={(e) => patch({ trade: e.target.value })}
            placeholder="Optional"
          />
        </div>
        <div>
          <label htmlFor="labor-vendor-phone" className="block text-sm font-semibold mb-1">
            Phone
          </label>
          <Input
            id="labor-vendor-phone"
            data-testid="labor-vendor-phone"
            className="h-11 text-base"
            type="tel"
            autoComplete="tel"
            value={draft.phone}
            disabled={busy}
            onChange={(e) => patch({ phone: e.target.value })}
            placeholder="Optional"
          />
        </div>
        <div className="min-[400px]:col-span-2">
          <label htmlFor="labor-vendor-email" className="block text-sm font-semibold mb-1">
            Email
          </label>
          <Input
            id="labor-vendor-email"
            data-testid="labor-vendor-email"
            className="h-11 text-base"
            type="email"
            autoComplete="email"
            value={draft.email}
            disabled={busy}
            onChange={(e) => patch({ email: e.target.value })}
            placeholder="Optional"
          />
        </div>
      </div>

      {canManage && isNew && (
        <label
          data-testid="labor-save-vendor-toggle"
          className="flex items-start gap-3 rounded-lg border border-slate-200 bg-white p-3 min-h-11 cursor-pointer"
        >
          <input
            type="checkbox"
            className="mt-1 h-4 w-4 shrink-0"
            checked={saveVendor}
            disabled={busy}
            onChange={(e) => onSaveVendorChange(e.target.checked)}
          />
          <span className="text-sm leading-snug">
            <span className="font-semibold text-slate-800">Save this vendor</span>
            <span className="block text-[11px] text-gray-500 mt-0.5">
              Leave unchecked for one-time use on this labor line only. Check to add them to your saved list for later jobs.
            </span>
          </span>
        </label>
      )}

      {canManage && selected && (
        <div className="flex flex-col min-[400px]:flex-row gap-2">
          <Button
            type="button"
            variant="outline"
            className="flex-1 min-h-11"
            disabled={busy}
            data-testid="labor-update-saved-vendor"
            onClick={() => void handleUpdateSaved()}
          >
            Update saved vendor
          </Button>
          <Button
            type="button"
            variant="outline"
            className="min-h-11 border-red-300 text-red-700 hover:bg-red-50"
            disabled={busy}
            data-testid="labor-delete-saved-vendor"
            onClick={() => void handleDeleteSaved()}
          >
            Remove from list
          </Button>
        </div>
      )}
    </div>
  );
}

export async function saveNewVendorIfRequested(opts: {
  canManage: boolean;
  saveVendor: boolean;
  draft: LaborVendorDraft;
  companyId: string;
  rate: number;
  persistVendor: LaborVendorPickerProps['persistVendor'];
}): Promise<CompanyVendor | null> {
  if (
    !shouldSaveNewVendor({
      canManage: opts.canManage,
      saveVendor: opts.saveVendor,
      name: opts.draft.name,
      selectedId: opts.draft.vendorId,
    })
  ) {
    return null;
  }
  return opts.persistVendor(vendorRowForWrite(opts.companyId, opts.draft, opts.rate || null), 'insert');
}

export function snapshotForLaborLine(draft: LaborVendorDraft): LaborVendorSnapshot {
  return vendorSnapshotFromDraft(draft);
}

