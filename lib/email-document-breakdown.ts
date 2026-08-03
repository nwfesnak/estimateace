/**
 * Format line-item breakdowns for estimate/invoice emails so they match
 * what clients see when materials/labor/cost toggles are on.
 */

import {
  normalizeStoredCostBreakdown,
  recalcBreakdownAsStored,
} from '@/lib/breakdown-pricing';

export type EmailBreakdownSettings = {
  showMaterialBreakdownOnEstimate?: boolean;
  showLaborBreakdownOnEstimate?: boolean;
  showCostBreakdownOnEstimate?: boolean;
};

function money(n: number) {
  return `$${Number(n || 0).toFixed(2)}`;
}

function escapeHtml(s: string) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getItemMaterials(item: any): any[] {
  if (Array.isArray(item?.materialsList) && item.materialsList.length > 0) {
    return item.materialsList;
  }
  if (item?.materialBreakdown?.description) {
    return [item.materialBreakdown];
  }
  return [];
}

function itemHasCostData(item: any): boolean {
  const materials = getItemMaterials(item);
  const labor = item?.laborBreakdown;
  const materialsHaveCost = materials.some(
    (m: any) => Number(m.unitPrice) > 0 || Number(m.total) > 0
  );
  const laborHasCost = !!labor && (Number(labor.rate) > 0 || Number(labor.total) > 0);
  return materialsHaveCost || laborHasCost;
}

function resolveSettings(settings?: EmailBreakdownSettings | null) {
  return {
    showMaterials: !!settings?.showMaterialBreakdownOnEstimate,
    showLabor: !!settings?.showLaborBreakdownOnEstimate,
    showCosts: !!settings?.showCostBreakdownOnEstimate,
  };
}

function getVisibleParts(item: any, settings?: EmailBreakdownSettings | null) {
  const { showMaterials, showLabor, showCosts } = resolveSettings(settings);
  return {
    showMaterials: showMaterials && getItemMaterials(item).length > 0,
    showLabor: showLabor && !!item?.laborBreakdown,
    showCosts: showCosts && itemHasCostData(item),
  };
}

function lineTotal(item: any): number {
  const total = Number(item?.total);
  if (total > 0) return total;
  return Math.round(((Number(item?.qty) || 1) * (Number(item?.price) || 0)) * 100) / 100;
}

/** Plain-text block under a line item (empty if nothing client-visible). */
export function formatItemBreakdownText(
  item: any,
  settings?: EmailBreakdownSettings | null
): string {
  const parts = getVisibleParts(item, settings);
  if (!parts.showMaterials && !parts.showLabor && !parts.showCosts) return '';

  const lines: string[] = [];
  const stored = recalcBreakdownAsStored(
    getItemMaterials(item) as any,
    item.laborBreakdown || null
  );

  if (parts.showMaterials && stored.materials.length > 0) {
    lines.push('   Materials needed:');
    for (const m of stored.materials) {
      const bit = [
        m.description || 'Material',
        m.qty != null ? `${m.qty} ${m.unit || ''}`.trim() : '',
        Number(m.unitPrice) > 0 ? `× ${money(Number(m.unitPrice))}` : '',
        Number(m.total) > 0 ? `= ${money(Number(m.total))}` : '',
      ]
        .filter(Boolean)
        .join(' ');
      lines.push(`   • ${bit}`);
    }
  }

  if (parts.showLabor && stored.labor) {
    const lab = stored.labor;
    const bit = [
      lab.description || 'Installation',
      lab.hours != null ? `${lab.hours} hrs` : '',
      Number(lab.rate) > 0 ? `× ${money(Number(lab.rate))}/hr` : '',
      Number(lab.total) > 0 ? `= ${money(Number(lab.total))}` : '',
    ]
      .filter(Boolean)
      .join(' ');
    lines.push(`   Labor: ${bit}`);
  }

  if (parts.showCosts) {
    const rawMaterials = getItemMaterials(item);
    const rawLabor = item.laborBreakdown;
    const preferStored = item.breakdownUserEdited === true || item.breakdownLocked === true;
    const normalized = normalizeStoredCostBreakdown({
      description: item.description || '',
      qty: Number(item.qty) || 1,
      unit: item.unit || '',
      unitPrice: Number(item.price) || 0,
      total: lineTotal(item),
      materials: rawMaterials as any,
      labor: rawLabor
        ? {
            description: rawLabor.description || 'Labor',
            hours: Number(rawLabor.hours) || 0,
            rate: Number(rawLabor.rate) || 0,
            total: Number(rawLabor.total) || 0,
          }
        : null,
      typicalLaborRate: 62,
      maxLaborRate: 75,
      expectedLaborHours: Number(rawLabor?.hours) || undefined,
      preferStored,
    });

    const materialsWithCost = normalized.materials.filter(
      (m: any) => Number(m.unitPrice) > 0 || Number(m.total) > 0
    );
    const labor = normalized.labor;
    const laborHasCost = !!labor && (Number(labor.rate) > 0 || Number(labor.total) > 0);

    if (materialsWithCost.length || laborHasCost) {
      lines.push('   Cost breakdown (full job):');
      if (materialsWithCost.length) {
        lines.push('   Materials cost:');
        for (const m of materialsWithCost) {
          const bit = [
            m.description || 'Material',
            m.qty != null ? `${m.qty} ${m.unit || ''}`.trim() : '',
            Number(m.unitPrice) > 0 ? `× ${money(Number(m.unitPrice))}` : '',
            Number(m.total) > 0 ? `= ${money(Number(m.total))}` : '',
          ]
            .filter(Boolean)
            .join(' ');
          lines.push(`   • ${bit}`);
        }
        lines.push(`   Materials subtotal: ${money(normalized.materialsCostTotal)}`);
      }
      if (laborHasCost && labor) {
        const bit = [
          labor.description || 'Installation',
          labor.hours != null ? `${labor.hours} hrs` : '',
          Number(labor.rate) > 0 ? `× ${money(Number(labor.rate))}/hr` : '',
          normalized.laborCostTotal > 0 ? `= ${money(normalized.laborCostTotal)}` : '',
        ]
          .filter(Boolean)
          .join(' ');
        lines.push(`   Labor cost: ${bit}`);
      }
      const builtUp = Math.round((normalized.materialsCostTotal + normalized.laborCostTotal) * 100) / 100;
      lines.push(`   Built-up job total: ${money(builtUp)}`);
    }
  }

  return lines.join('\n');
}

/** HTML block under a line item (empty string if nothing client-visible). */
export function formatItemBreakdownHtml(
  item: any,
  settings?: EmailBreakdownSettings | null
): string {
  const parts = getVisibleParts(item, settings);
  if (!parts.showMaterials && !parts.showLabor && !parts.showCosts) return '';

  const chunks: string[] = [];
  const stored = recalcBreakdownAsStored(
    getItemMaterials(item) as any,
    item.laborBreakdown || null
  );

  if (parts.showMaterials && stored.materials.length > 0) {
    const lis = stored.materials
      .map((m) => {
        const bit = [
          escapeHtml(String(m.description || 'Material')),
          m.qty != null ? ` — ${escapeHtml(String(m.qty))} ${escapeHtml(String(m.unit || ''))}`.trim() : '',
          Number(m.unitPrice) > 0 ? ` × ${money(Number(m.unitPrice))}` : '',
          Number(m.total) > 0 ? ` = ${money(Number(m.total))}` : '',
        ].join('');
        return `<li style="margin:2px 0;">${bit}</li>`;
      })
      .join('');
    chunks.push(
      `<div style="margin-top:6px;font-size:12px;color:#475569;"><div style="font-weight:600;">Materials needed:</div><ul style="margin:4px 0 0;padding-left:18px;">${lis}</ul></div>`
    );
  }

  if (parts.showLabor && stored.labor) {
    const lab = stored.labor;
    const bit = [
      escapeHtml(String(lab.description || 'Installation')),
      lab.hours != null ? ` — ${lab.hours} hrs` : '',
      Number(lab.rate) > 0 ? ` × ${money(Number(lab.rate))}/hr` : '',
      Number(lab.total) > 0 ? ` = ${money(Number(lab.total))}` : '',
    ].join('');
    chunks.push(
      `<div style="margin-top:4px;font-size:12px;color:#475569;"><strong>Labor:</strong> ${bit}</div>`
    );
  }

  if (parts.showCosts) {
    const rawMaterials = getItemMaterials(item);
    const rawLabor = item.laborBreakdown;
    const preferStored = item.breakdownUserEdited === true || item.breakdownLocked === true;
    const normalized = normalizeStoredCostBreakdown({
      description: item.description || '',
      qty: Number(item.qty) || 1,
      unit: item.unit || '',
      unitPrice: Number(item.price) || 0,
      total: lineTotal(item),
      materials: rawMaterials as any,
      labor: rawLabor
        ? {
            description: rawLabor.description || 'Labor',
            hours: Number(rawLabor.hours) || 0,
            rate: Number(rawLabor.rate) || 0,
            total: Number(rawLabor.total) || 0,
          }
        : null,
      typicalLaborRate: 62,
      maxLaborRate: 75,
      expectedLaborHours: Number(rawLabor?.hours) || undefined,
      preferStored,
    });

    const materialsWithCost = normalized.materials.filter(
      (m: any) => Number(m.unitPrice) > 0 || Number(m.total) > 0
    );
    const labor = normalized.labor;
    const laborHasCost = !!labor && (Number(labor.rate) > 0 || Number(labor.total) > 0);

    if (materialsWithCost.length || laborHasCost) {
      const costBits: string[] = [
        `<div style="font-weight:600;margin-bottom:4px;">Cost breakdown (full job):</div>`,
      ];
      if (materialsWithCost.length) {
        const lis = materialsWithCost
          .map((m: any) => {
            const bit = [
              escapeHtml(String(m.description || 'Material')),
              m.qty != null
                ? ` — ${escapeHtml(String(m.qty))} ${escapeHtml(String(m.unit || ''))}`.trim()
                : '',
              Number(m.unitPrice) > 0 ? ` × ${money(Number(m.unitPrice))}` : '',
              Number(m.total) > 0 ? ` = ${money(Number(m.total))}` : '',
            ].join('');
            return `<li style="margin:2px 0;">${bit}</li>`;
          })
          .join('');
        costBits.push(
          `<div style="font-weight:500;">Materials cost:</div><ul style="margin:4px 0;padding-left:18px;">${lis}</ul>`
        );
        costBits.push(
          `<div>Materials subtotal: ${money(normalized.materialsCostTotal)}</div>`
        );
      }
      if (laborHasCost && labor) {
        const bit = [
          escapeHtml(String(labor.description || 'Installation')),
          labor.hours != null ? ` — ${labor.hours} hrs` : '',
          Number(labor.rate) > 0 ? ` × ${money(Number(labor.rate))}/hr` : '',
          normalized.laborCostTotal > 0 ? ` = ${money(normalized.laborCostTotal)}` : '',
        ].join('');
        costBits.push(`<div style="margin-top:4px;"><strong>Labor cost:</strong> ${bit}</div>`);
      }
      const builtUp =
        Math.round((normalized.materialsCostTotal + normalized.laborCostTotal) * 100) / 100;
      costBits.push(
        `<div style="font-weight:600;margin-top:4px;">Built-up job total: ${money(builtUp)}</div>`
      );
      chunks.push(
        `<div style="margin-top:8px;padding-top:8px;border-top:1px solid #e2e8f0;font-size:12px;color:#475569;">${costBits.join('')}</div>`
      );
    }
  }

  if (!chunks.length) return '';
  return `<div style="margin-top:6px;padding:8px 10px;background:#f8fafc;border-radius:6px;">${chunks.join('')}</div>`;
}
