/**
 * DOM-free decisions behind `Modal` and `ConfirmDialog`, kept apart so they can be
 * unit-tested without a browser.
 */

/**
 * Where Tab should send focus inside a dialog, or `null` to let the browser move it.
 *
 * `count` is the number of tabbable elements in the dialog, in DOM order, and
 * `currentIndex` is the position of the focused one among them (-1 when focus is
 * on the dialog itself, or has escaped it). Only the two edges are taken over, so
 * the browser keeps its own handling everywhere in between.
 *
 * Returns -1 when there is nothing tabbable: focus stays on the dialog rather than
 * leaving for the page behind it.
 */
export function trapTabTarget(count: number, currentIndex: number, shift: boolean): number | null {
  if (count <= 0) return -1;
  if (currentIndex < 0 || currentIndex >= count) return shift ? count - 1 : 0;
  if (shift && currentIndex === 0) return count - 1;
  if (!shift && currentIndex === count - 1) return 0;
  return null;
}

/**
 * Whether a dialog whose `initialFocusRef` target could not take focus on open (it was
 * disabled while the dialog loaded) should move focus there now that it can.
 *
 * Only while focus still sits where the dialog parked it as a fallback and the
 * operator has not moved it since: a dialog that finishes loading must not pull focus
 * away from a field the operator already tabbed or clicked into. Tabbing away and
 * back onto the fallback counts as moving it.
 */
export function shouldApplyDeferredFocus({
  ready,
  parkedOn,
  active,
  operatorMoved,
}: {
  /** The caller says the initial-focus target can take focus now. */
  ready: boolean;
  /** Where the dialog put focus because the target could not take it; null if it could. */
  parkedOn: unknown;
  /** `document.activeElement` now. */
  active: unknown;
  /** Focus has moved, or the pointer went down in the dialog, since it was parked. */
  operatorMoved: boolean;
}): boolean {
  return ready && parkedOn != null && !operatorMoved && active === parkedOn;
}

/**
 * Open modals, innermost last. Escape and the Tab trap belong to the top one only:
 * a confirm raised over the Stream Info modal must close itself, not both.
 */
export function createModalStack() {
  const ids: number[] = [];
  return {
    push(id: number) {
      ids.push(id);
    },
    remove(id: number) {
      const index = ids.lastIndexOf(id);
      if (index !== -1) ids.splice(index, 1);
    },
    isTop(id: number) {
      return ids.length > 0 && ids[ids.length - 1] === id;
    },
    get size() {
      return ids.length;
    },
  };
}

/**
 * Whether the text typed into a confirm's "type X to confirm" box unlocks it.
 * Case and surrounding whitespace are forgiven; anything else is not, because the
 * point is that the operator read the name of what they are about to destroy.
 */
export function confirmTextMatches(typed: string, required: string): boolean {
  const want = required.trim().toLowerCase();
  if (!want) return true;
  return typed.trim().toLowerCase() === want;
}
