/**
 * Optional estimate lines. Required lines are always in the total.
 * Optional lines stay out until the client chooses to add them.
 */

export function isOptionalLine(item: any): boolean {
  return item?.optional === true || item?.optional === 'true' || item?.optional === 1;
}

export function isClientSelectedOption(item: any): boolean {
  return (
    item?.clientSelected === true ||
    item?.clientSelected === 'true' ||
    item?.clientSelected === 1
  );
}

/** Required lines count. Optional lines count only after the client adds them. */
export function lineCountsTowardTotal(item: any): boolean {
  if (!isOptionalLine(item)) return true;
  return isClientSelectedOption(item);
}

export function lineOptionId(item: any, index: number): string {
  if (item?.id != null && String(item.id).trim() !== '') return String(item.id);
  return `idx-${index}`;
}

export function lineMoney(item: any): number {
  const raw = item?.total;
  const total = Number(raw);
  if (raw != null && raw !== '' && Number.isFinite(total)) {
    return Math.round(total * 100) / 100;
  }
  const qty = Number(item?.qty) || 0;
  const price = Number(item?.price) || 0;
  return Math.round(qty * price * 100) / 100;
}

export function includedItemsSubtotal(items: any[]): number {
  const sum = (items || []).reduce((acc, item) => {
    if (!lineCountsTowardTotal(item)) return acc;
    return acc + lineMoney(item);
  }, 0);
  return Math.round(sum * 100) / 100;
}

export function openOptionalSubtotal(items: any[]): number {
  const sum = (items || []).reduce((acc, item) => {
    if (!isOptionalLine(item) || isClientSelectedOption(item)) return acc;
    return acc + lineMoney(item);
  }, 0);
  return Math.round(sum * 100) / 100;
}

export function optionalLineNote(item: any): string {
  if (!isOptionalLine(item)) return '';
  if (isClientSelectedOption(item)) return ' (Optional — client added)';
  return ' (Optional — not in total until the client adds it)';
}

export type QuoteDiscountInput = {
  description?: string;
  value?: number;
  type?: string;
  amount?: number;
};

export function quoteTotalsForItems(input: {
  items: any[];
  /** When set, these ids are the optional lines the client is adding. */
  selectedIds?: string[] | null;
  discount?: QuoteDiscountInput;
  taxRate?: number;
  taxesEnabled?: boolean;
  isTaxExempt?: boolean;
}) {
  const items = Array.isArray(input.items) ? input.items : [];
  const selected = input.selectedIds ? new Set(input.selectedIds.map(String)) : null;
  let included = 0;
  let optionalOpen = 0;
  items.forEach((item, index) => {
    const amount = lineMoney(item);
    const optional = isOptionalLine(item);
    const chosen = selected
      ? selected.has(lineOptionId(item, index))
      : isClientSelectedOption(item);
    if (!optional || chosen) included += amount;
    else optionalOpen += amount;
  });
  included = Math.round(included * 100) / 100;
  optionalOpen = Math.round(optionalOpen * 100) / 100;

  const discountType = input.discount?.type === 'percent' ? 'percent' : 'dollar';
  const discountValue = Number(input.discount?.value) || 0;
  const storedAmount = Number(input.discount?.amount) || 0;
  let discountAmount = 0;
  if (included > 0) {
    if (discountType === 'percent' && discountValue > 0) {
      discountAmount = Math.min(included, included * (discountValue / 100));
    } else if (discountValue > 0) {
      discountAmount = Math.min(included, discountValue);
    } else if (storedAmount > 0) {
      discountAmount = Math.min(included, storedAmount);
    }
  }
  discountAmount = Math.round(discountAmount * 100) / 100;

  const taxable = Math.max(0, Math.round((included - discountAmount) * 100) / 100);
  const taxRate = Number(input.taxRate) || 0;
  const taxAmount =
    input.taxesEnabled !== false && !input.isTaxExempt && taxRate > 0
      ? Math.round(taxable * (taxRate / 100) * 100) / 100
      : 0;
  const grandTotal = Math.max(0, Math.round((taxable + taxAmount) * 100) / 100);
  const optionalCount = items.filter((item) => isOptionalLine(item)).length;
  const allOptional = items.length > 0 && optionalCount === items.length;

  return {
    includedSubtotal: included,
    optionalOpenTotal: optionalOpen,
    discountAmount,
    taxAmount,
    grandTotal,
    allOptional,
    optionalCount,
  };
}

/** Mark which optional lines the client chose. Required lines are unchanged. */
export function applyClientOptionSelection(items: any[], selectedIds: string[]): any[] {
  const selected = new Set((selectedIds || []).map(String));
  return (items || []).map((item, index) => {
    if (!isOptionalLine(item)) {
      if (!item || item.clientSelected == null) return item;
      const next = { ...item };
      delete next.clientSelected;
      return next;
    }
    return {
      ...item,
      clientSelected: selected.has(lineOptionId(item, index)),
    };
  });
}
