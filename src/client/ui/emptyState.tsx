import React from 'react';
import { CrystalOrb } from '../crystalOrb';
import { emptyStateLayout, type EmptyStateSize } from './emptyStateLogic';

export type { EmptyStateSize } from './emptyStateLogic';

/**
 * The one way to say "nothing here" or "can't show this": the moon orb, a Cormorant
 * italic title, and a plain sentence under it.
 *
 * Wording rule: the title names the state ("No chatters yet", "Chatters
 * unavailable", "Gathering your viewers…"), never a bare "Unavailable"; the sentence
 * says why, or what will fill the space, in plain words.
 *
 * `size="panel"` fills a dashboard panel or a full-width list (`.empty-state`);
 * `size="pane"` is the larger right-hand pane of a split editor (`.split-empty`);
 * `size="compact"` sits in a settings list column or a card (`.empty-state--compact`);
 * `size="note"` is a short left-aligned note for a dense spot inside a panel that
 * already has its own heading — a tablet button grid (`.empty-state--note`). It spans
 * every column when it lands in a grid, and drops the orb unless `orb` is passed.
 *
 * `action` is the one control that ends the empty state ("Create first reward"). Leave
 * it out when the control is already on screen above the list.
 *
 * An inline note inside an editor ("No steps yet. Add one below.") is not an empty
 * state — that stays a `command-empty` line beside the control it is about.
 */
export function EmptyState({
  title,
  children,
  orb,
  size = 'panel',
  action,
}: {
  title: React.ReactNode;
  /** The sentence under the title. */
  children?: React.ReactNode;
  /** Defaults to true, except for `size="note"`. */
  orb?: boolean;
  size?: EmptyStateSize;
  action?: React.ReactNode;
}) {
  const layout = emptyStateLayout(size);
  const showOrb = orb ?? layout.orbByDefault;
  return (
    <div className={layout.className}>
      {showOrb ? <CrystalOrb variant="moon" size={layout.orbSize} /> : null}
      <div className="es-title">{title}</div>
      {children != null && children !== false ? <div className="es-sub">{children}</div> : null}
      {action ? <div className="es-action">{action}</div> : null}
    </div>
  );
}
