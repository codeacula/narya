/**
 * How each `EmptyState` size is drawn. Kept apart from the component so the mapping is
 * testable without a renderer.
 *
 * - `panel`: fills a dashboard panel or a full-width settings list.
 * - `pane`: the larger right-hand pane of a split editor.
 * - `compact`: a settings list column or a card's body — the same orb, title and
 *   sentence, at a size that does not shove the column's first row off screen.
 */
export type EmptyStateSize = 'panel' | 'pane' | 'compact';

export function emptyStateLayout(size: EmptyStateSize): { className: string; orbSize: number } {
  switch (size) {
    case 'pane':
      return { className: 'split-empty', orbSize: 40 };
    case 'compact':
      return { className: 'empty-state empty-state--compact', orbSize: 26 };
    case 'panel':
      return { className: 'empty-state', orbSize: 40 };
  }
}
