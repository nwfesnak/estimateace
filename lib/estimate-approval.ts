/**
 * Estimate approval (won job) — schedule on calendar without converting to invoice.
 * Stored on the document profile so no DB migration is required.
 */

export type EstimateApprovedBy = 'owner' | 'client';

export type EstimateApproval = {
  approvedAt: string | null;
  approvedBy: EstimateApprovedBy | null;
};

export function readEstimateApproval(row: any): EstimateApproval {
  if (!row) return { approvedAt: null, approvedBy: null };
  const profile = row.profile && typeof row.profile === 'object' ? row.profile : {};
  const approvedAt = String(
    row.approvedAt ||
      row.approvedat ||
      profile._estimateApprovedAt ||
      profile.estimateApprovedAt ||
      ''
  ).trim();
  const byRaw = String(
    row.approvedBy ||
      row.approvedby ||
      profile._estimateApprovedBy ||
      profile.estimateApprovedBy ||
      ''
  )
    .trim()
    .toLowerCase();
  const approvedBy: EstimateApprovedBy | null =
    byRaw === 'owner' || byRaw === 'client' ? (byRaw as EstimateApprovedBy) : approvedAt ? 'client' : null;
  if (!approvedAt) return { approvedAt: null, approvedBy: null };
  return { approvedAt, approvedBy };
}

export function isEstimateApproved(row: any): boolean {
  return Boolean(readEstimateApproval(row).approvedAt);
}

export function withEstimateApproval(
  profile: Record<string, unknown> | null | undefined,
  approval: EstimateApproval
): Record<string, unknown> {
  const next = { ...(profile && typeof profile === 'object' ? profile : {}) };
  if (approval.approvedAt) {
    next._estimateApprovedAt = approval.approvedAt;
    next._estimateApprovedBy = approval.approvedBy || 'owner';
  } else {
    delete next._estimateApprovedAt;
    delete next._estimateApprovedBy;
    delete next.estimateApprovedAt;
    delete next.estimateApprovedBy;
  }
  return next;
}

export function approvalBadgeLabel(row: any): string | null {
  const a = readEstimateApproval(row);
  if (!a.approvedAt) return null;
  if (a.approvedBy === 'owner') return 'Approved (owner)';
  if (a.approvedBy === 'client') return 'Approved (client)';
  return 'Approved';
}
