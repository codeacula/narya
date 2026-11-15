import type { PinnedCard } from '../shared/api';
import type { LiveValueHealth, LiveValueStatus } from './liveValue';

/**
 * What the operator controls say about a live value they write (the mute, the
 * holding-scene clocks, the pinned card, the overlay bounds), kept apart from the
 * components so the rule is written once and tested.
 *
 * The rule: a value the server has not given is never drawn as the value's "nothing"
 * (unmuted, no countdown, nothing pinned, bounds off). That fallback is a placeholder,
 * and drawing it as fact hides exactly the state the operator most needs to act on —
 * a card still on stream, boxes still drawn over a live scene.
 */

/**
 * The problem line under a control whose value could not be read (`failed`), or was
 * read but has since failed to refresh (`stale`). `subject` completes "Could not read
 * …" ("whether commands are muted"). Null when the value is current.
 */
export function liveValueProblem(health: LiveValueHealth, subject: string): string | null {
  if (health.status === 'failed') return `Could not read ${subject}.`;
  if (health.stale) return `Could not refresh ${subject}. Showing the last known state.`;
  return null;
}

/** One-line readout of the current card, for when the card is known. */
export function pinnedCardSummary(card: PinnedCard | null): string {
  if (!card) return 'nothing pinned';
  return card.kind === 'question' ? `${card.name} asks: ${card.text}` : `topic: ${card.text}`;
}

/** The pinned card readout. `empty` dims it; an unknown card is not "nothing pinned". */
export function pinnedCardReadout(status: LiveValueStatus, card: PinnedCard | null): { text: string; empty: boolean } {
  if (status === 'loading') return { text: 'checking the pinned card', empty: true };
  if (status === 'failed') return { text: 'pinned card unknown', empty: true };
  return { text: pinnedCardSummary(card), empty: card === null };
}

/**
 * A holding-scene clock readout. `label` is the ticking countdown, or null when none
 * is set; `none` is how the surface says "no countdown" ("—" on the dense dashboard).
 */
export function holdingReadoutText(status: LiveValueStatus, label: string | null, none: string): string {
  if (status === 'loading') return '';
  if (status === 'failed') return 'unknown';
  return label ?? none;
}

/**
 * Whether a Clear button is offered. While the value is unknown it is: the server may
 * be holding something on stream, and clearing what is not there is harmless. Once
 * the value is known, only when there is something to clear.
 */
export function clearOffered(status: LiveValueStatus, hasValue: boolean): boolean {
  return status !== 'loaded' || hasValue;
}

/**
 * The operator's overlay-bounds switch. The browser sources fail closed (no boxes when
 * they cannot tell), but the operator's switch must not: drawn unticked while the
 * server has outlines on, it would hide the "turn this off before going live" warning
 * at the one moment it matters.
 */
export function overlayBoundsFace(status: LiveValueStatus, enabled: boolean): {
  checked: boolean;
  /** The switch takes no input until the state is known. */
  locked: boolean;
  /** The outlines are on: say so loudly. */
  warn: boolean;
  unreadable: string | null;
} {
  const known = status === 'loaded';
  return {
    checked: known && enabled,
    locked: !known,
    warn: known && enabled,
    unreadable: status === 'failed'
      ? 'Could not read whether overlay bounds are on. If they are, every overlay source is drawing outlines.'
      : null,
  };
}
