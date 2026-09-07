/**
 * Grand total for a saved estimate/invoice row — must match client approve UI
 * and /api/client/document (items − discount + tax; laborAmount is reference-only).
 */

function roundMoney(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function itemsSubtotal(items: any[]): number {
  return roundMoney(
    (items || []).reduce((sum, it) => {
      const t = Number(it?.total);
      if (Number.isFinite(t) && t > 0) return sum + t;
      return sum + (Number(it?.qty) || 0) * (Number(it?.price) || 0);
    }, 0)
  );
}

function discountFromDoc(row: any, itemsTotal: number): number {
  const profile = (row?.profile && typeof row.profile === 'object' ? row.profile : {}) as any;
  const stored = profile._discount || {};
  const discountType =
    (row?.discountType || row?.discounttype || stored.discountType) === 'percent'
      ? 'percent'
      : 'dollar';
  const discountValue = Number(row?.discountValue ?? row?.discountvalue ?? stored.discountValue) || 0;
  let discountAmount = Number(row?.discountAmount ?? row?.discountamount ?? stored.discountAmount) || 0;
  if (!(discountAmount > 0) && discountValue > 0 && itemsTotal > 0) {
    discountAmount =
      discountType === 'percent'
        ? roundMoney(Math.min(itemsTotal, itemsTotal * (discountValue / 100)))
        : roundMoney(Math.min(itemsTotal, discountValue));
  }
  return roundMoney(Math.min(itemsTotal, Math.max(0, discountAmount)));
}

/**
 * Canonical job total for pay links and mark-paid.
 * Prefer a stored grandTotal when present; otherwise items − discount + tax.
 * Do NOT add document laborAmount (UI treats it as reference only).
 */
export function computeDocumentGrandTotal(row: any): number {
  if (!row) return 0;
  const items = Array.isArray(row.items) ? row.items : [];
  const itemsTotal = itemsSubtotal(items);
  const discountAmount = discountFromDoc(row, itemsTotal);
  const subtotalAfterDiscount = roundMoney(Math.max(0, itemsTotal - discountAmount));
  const taxAmount = Number(row.taxAmount ?? row.taxamount ?? row.tax_amount) || 0;

  const stored =
    Number(row.grandTotal ?? row.grandtotal ?? row.grand_total ?? row.total) || 0;
  if (stored > 0.009) return roundMoney(stored);

  if (taxAmount > 0.009) return roundMoney(subtotalAfterDiscount + taxAmount);
  return subtotalAfterDiscount > 0.009 ? subtotalAfterDiscount : itemsTotal;
}
