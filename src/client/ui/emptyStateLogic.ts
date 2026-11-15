/**
 * How each `EmptyState` size is drawn. Kept apart from the component so the mapping is
 * testable without a renderer.
 *
 * - `panel`: fills a dashboard panel or a full-width settings list.
 * - `pane`: the larger right-hand pane of a split editor.
 * - `compact`: a settings list column or a card's body — the same orb, title and
 *   sentence, centred, at a size that does not shove the column's first row off screen.
 * - `note`: a short left-aligned note for a dense spot inside a panel that already has
 *   its own heading — a tablet button grid. It spans every column when it lands in a
 *   grid, and drops the orb by default, since even a small moon would outweigh the two
 *   lines beside it.
 */
export type EmptyStateSize = 'panel' | 'pane' | 'compact' | 'note';

export function emptyStateLayout(size: EmptyStateSize): {
  className: string;
  orbSize: number;
  /** Whether the orb shows when the caller does not pass `orb`. */
  orbByDefault: boolean;
} {
  switch (size) {
    case 'pane':
      return { className: 'split-empty', orbSize: 40, orbByDefault: true };
    case 'compact':
      return { className: 'empty-state empty-state--compact', orbSize: 26, orbByDefault: true };
    case 'note':
      return { className: 'empty-state empty-state--note', orbSize: 24, orbByDefault: false };
    case 'panel':
      return { className: 'empty-state', orbSize: 40, orbByDefault: true };
  }
}
