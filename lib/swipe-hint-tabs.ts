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
