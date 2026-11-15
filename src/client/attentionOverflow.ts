/**
 * What lies below the visible part of a scrolling list — the attention feed's "n more
 * below" cue. Kept free of the DOM so the counting rule is testable: the panel measures
 * its rows and hands the numbers in.
 */

/** One row's vertical extent in the list's scroll coordinates (offsetTop / offsetHeight). */
export type ListRow = { top: number; bottom: number; unacked: boolean };

export type ListViewport = { scrollTop: number; clientHeight: number };

export type OverflowBelow = {
  /** Rows not fully readable: cut by the bottom edge, or entirely past it. */
  count: number;
  /** How many of those still carry an unacknowledged highlight. */
  unacked: number;
  /** Where "show me" should scroll to, or null when nothing is below. */
  scrollTarget: number | null;
};

/**
 * Sub-pixel layout (zoom, fractional row heights) can leave the last row a fraction of a
 * pixel past the edge when it is in fact fully shown; that must not read as "1 more".
 */
const EDGE_TOLERANCE_PX = 1;

export const NOTHING_BELOW: OverflowBelow = { count: 0, unacked: 0, scrollTarget: null };

export function overflowBelow(rows: readonly ListRow[], viewport: ListViewport): OverflowBelow {
  const viewBottom = viewport.scrollTop + viewport.clientHeight;
  let count = 0;
  let unacked = 0;
  let firstTop: number | null = null;
  for (const row of rows) {
    // A row cut by the edge counts: its detail line is exactly what goes unread.
    if (row.bottom <= viewBottom + EDGE_TOLERANCE_PX) continue;
    count++;
    if (row.unacked) unacked++;
    if (firstTop === null) firstTop = row.top;
  }
  if (firstTop === null) return NOTHING_BELOW;
  // Bring the first unread row to the top. A row taller than the viewport would already
  // start above the top edge, and scrolling "to" it would go nowhere or backwards — page
  // down instead.
  const scrollTarget = firstTop > viewport.scrollTop ? firstTop : viewBottom;
  return { count, unacked, scrollTarget };
}

export function sameOverflow(a: OverflowBelow, b: OverflowBelow): boolean {
  return a.count === b.count && a.unacked === b.unacked && a.scrollTarget === b.scrollTarget;
}

/** "3 more below", or "3 more below · 2 new" when some of them are still highlighted. */
export function overflowLabel(overflow: OverflowBelow): string {
  const base = `${overflow.count} more below`;
  return overflow.unacked > 0 ? `${base} · ${overflow.unacked} new` : base;
}
