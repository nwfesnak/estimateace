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
