import { describe, expect, test } from 'bun:test';
import { confirmTextMatches, createModalStack, shouldApplyDeferredFocus, trapTabTarget } from './modalLogic';

describe('trapTabTarget', () => {
  test('Tab on the last element wraps to the first', () => {
    expect(trapTabTarget(3, 2, false)).toBe(0);
  });

  test('Shift+Tab on the first element wraps to the last', () => {
    expect(trapTabTarget(3, 0, true)).toBe(2);
  });

  test('the browser moves focus between interior elements', () => {
    expect(trapTabTarget(3, 0, false)).toBeNull();
    expect(trapTabTarget(3, 1, false)).toBeNull();
    expect(trapTabTarget(3, 1, true)).toBeNull();
    expect(trapTabTarget(3, 2, true)).toBeNull();
  });

  test('focus on the dialog itself or outside it re-enters at the matching edge', () => {
    expect(trapTabTarget(3, -1, false)).toBe(0);
    expect(trapTabTarget(3, -1, true)).toBe(2);
    expect(trapTabTarget(3, 7, false)).toBe(0);
  });

  test('a single element keeps focus on itself both ways', () => {
    expect(trapTabTarget(1, 0, false)).toBe(0);
    expect(trapTabTarget(1, 0, true)).toBe(0);
  });

  test('nothing tabbable keeps focus on the dialog', () => {
    expect(trapTabTarget(0, -1, false)).toBe(-1);
    expect(trapTabTarget(0, -1, true)).toBe(-1);
  });
});

describe('createModalStack', () => {
  test('only the most recently opened modal is on top', () => {
    const stack = createModalStack();
    stack.push(1);
    stack.push(2);
    expect(stack.isTop(2)).toBe(true);
    expect(stack.isTop(1)).toBe(false);
  });

  test('closing the top modal hands the keyboard back to the one beneath', () => {
    const stack = createModalStack();
    stack.push(1);
    stack.push(2);
    stack.remove(2);
    expect(stack.isTop(1)).toBe(true);
  });

  test('closing a modal underneath leaves the top one in charge', () => {
    const stack = createModalStack();
    stack.push(1);
    stack.push(2);
    stack.remove(1);
    expect(stack.isTop(2)).toBe(true);
    expect(stack.size).toBe(1);
  });

  test('an empty stack has no top, and removing an unknown id is harmless', () => {
    const stack = createModalStack();
    stack.remove(4);
    expect(stack.isTop(4)).toBe(false);
    expect(stack.size).toBe(0);
  });
});

describe('confirmTextMatches', () => {
  test('exact text unlocks', () => {
    expect(confirmTextMatches('Hydrate', 'Hydrate')).toBe(true);
  });

  test('case and surrounding whitespace are forgiven', () => {
    expect(confirmTextMatches('  hYDRATE ', 'Hydrate')).toBe(true);
  });

  test('a partial or different word does not unlock', () => {
    expect(confirmTextMatches('Hydr', 'Hydrate')).toBe(false);
    expect(confirmTextMatches('', 'Hydrate')).toBe(false);
    expect(confirmTextMatches('Hydrate!', 'Hydrate')).toBe(false);
  });

  test('inner whitespace still has to match', () => {
    expect(confirmTextMatches('drink water', 'Drink  water')).toBe(false);
    expect(confirmTextMatches('drink  water', 'Drink  water')).toBe(true);
  });

  test('a blank requirement needs no typing', () => {
    expect(confirmTextMatches('', '   ')).toBe(true);
  });
});

describe('shouldApplyDeferredFocus', () => {
  const close = { name: 'close button' };
  const field = { name: 'another field' };
  const base = { ready: true, parkedOn: close, active: close, operatorMoved: false };

  test('focus moves to the target once it is ready, while still parked on the fallback', () => {
    expect(shouldApplyDeferredFocus(base)).toBe(true);
  });

  test('not before the target is ready', () => {
    expect(shouldApplyDeferredFocus({ ...base, ready: false })).toBe(false);
  });

  test('never when the target took focus on open (nothing was parked)', () => {
    expect(shouldApplyDeferredFocus({ ...base, parkedOn: null })).toBe(false);
  });

  test('never steals focus the operator moved elsewhere', () => {
    expect(shouldApplyDeferredFocus({ ...base, active: field, operatorMoved: true })).toBe(false);
  });

  test('tabbing away and back onto the fallback still counts as the operator moving it', () => {
    expect(shouldApplyDeferredFocus({ ...base, operatorMoved: true })).toBe(false);
  });

  test('focus that left without a focusin in the dialog (to the page behind) is left alone', () => {
    expect(shouldApplyDeferredFocus({ ...base, active: field })).toBe(false);
  });
});
