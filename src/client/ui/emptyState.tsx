import React from 'react';
import { CrystalOrb } from '../crystalOrb';

/**
 * The one way to say "nothing here" or "can't show this": the moon orb, a Cormorant
 * italic title, and a plain sentence under it.
 *
 * Wording rule: the title names the state ("No chatters yet", "Chatters
 * unavailable", "Gathering your viewers…"), never a bare "Unavailable"; the sentence
 * says why, or what will fill the space, in plain words.
 *
 * `size="panel"` fills a dashboard panel or list (`.empty-state`); `size="pane"` is
 * the larger right-hand pane of a split editor (`.split-empty`).
 */
export function EmptyState({
  title,
  children,
  orb = true,
  size = 'panel',
}: {
  title: React.ReactNode;
  /** The sentence under the title. */
  children?: React.ReactNode;
  orb?: boolean;
  size?: 'panel' | 'pane';
}) {
  return (
    <div className={size === 'pane' ? 'split-empty' : 'empty-state'}>
      {orb ? <CrystalOrb variant="moon" size={40} /> : null}
      <div className="es-title">{title}</div>
      {children != null && children !== false ? <div className="es-sub">{children}</div> : null}
    </div>
  );
}
