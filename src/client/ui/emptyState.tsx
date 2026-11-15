import React from 'react';
import { CrystalOrb } from '../crystalOrb';

export type EmptyStateSize = 'panel' | 'pane' | 'compact';

export function emptyStateClass(size: EmptyStateSize): string {
  if (size === 'pane') return 'split-empty';
  if (size === 'compact') return 'empty-state empty-state--compact';
  return 'empty-state';
}

/**
 * The one way to say "nothing here" or "can't show this": the moon orb, a Cormorant
 * italic title, and a plain sentence under it.
 *
 * Wording rule: the title names the state ("No chatters yet", "Chatters
 * unavailable", "Gathering your viewers…"), never a bare "Unavailable"; the sentence
 * says why, or what will fill the space, in plain words.
 *
 * `size="panel"` fills a dashboard panel or list (`.empty-state`); `size="pane"` is
 * the larger right-hand pane of a split editor (`.split-empty`); `size="compact"` is
 * a short left-aligned note for a dense spot inside a panel that already has its own
 * heading — a button grid, a history list (`.empty-state.empty-state--compact`). It
 * spans every column when it lands in a grid. Compact drops the orb unless `orb` is
 * passed, since a 40px moon would outweigh the two lines beside it.
 */
export function EmptyState({
  title,
  children,
  orb,
  size = 'panel',
}: {
  title: React.ReactNode;
  /** The sentence under the title. */
  children?: React.ReactNode;
  /** Defaults to true, except for `size="compact"`. */
  orb?: boolean;
  size?: EmptyStateSize;
}) {
  const showOrb = orb ?? size !== 'compact';
  return (
    <div className={emptyStateClass(size)}>
      {showOrb ? <CrystalOrb variant="moon" size={size === 'compact' ? 24 : 40} /> : null}
      <div className="es-title">{title}</div>
      {children != null && children !== false ? <div className="es-sub">{children}</div> : null}
    </div>
  );
}
