/** Chevron button size (px). Matches the 44px / h-11 w-11 tap target. */
export const TAB_STRIP_ARROW_PX = 44;

/**
 * Horizontal inset on each end of the scroll row, at least the arrow width,
 * so the chevron and fade never cover or crowd tab labels.
 */
export const TAB_STRIP_EDGE_PAD_PX = 48;

/** Overflow state for a horizontally scrolling tab strip. */
export function getTabStripOverflow(
  metrics: { scrollLeft: number; scrollWidth: number; clientWidth: number },
  slop = 2
): { canScrollLeft: boolean; canScrollRight: boolean } {
  const scrollLeft = Number(metrics.scrollLeft) || 0;
  const scrollWidth = Number(metrics.scrollWidth) || 0;
  const clientWidth = Number(metrics.clientWidth) || 0;
  const max = Math.max(0, scrollWidth - clientWidth);
  return {
    canScrollLeft: scrollLeft > slop,
    canScrollRight: max > slop && scrollLeft < max - slop,
  };
}

/** Distance to scroll when a swipe-hint arrow is tapped. */
export function tabStripScrollAmount(clientWidth: number): number {
  const width = Number(clientWidth) || 0;
  return Math.max(Math.round(width * 0.7), 120);
}

/** True when a tab's text overflows its box (e.g. a nowrap label in a too-narrow flex item). */
export function tabLabelOverflows(
  el: { scrollWidth: number; clientWidth: number },
  slop = 1
): boolean {
  return (Number(el.scrollWidth) || 0) > (Number(el.clientWidth) || 0) + slop;
}

/** True when any tab bounding box overlaps a neighbor. */
export function tabBoxesOverlap(
  boxes: Array<{ x: number; width: number }>,
  slop = 1
): boolean {
  const sorted = [...boxes].sort((a, b) => a.x - b.x);
  for (let i = 1; i < sorted.length; i++) {
    const prevRight = sorted[i - 1].x + sorted[i - 1].width;
    if (sorted[i].x < prevRight - slop) return true;
  }
  return false;
}
