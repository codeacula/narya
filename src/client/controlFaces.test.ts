import { describe, expect, test } from 'bun:test';
import {
  clearOffered,
  holdingReadoutText,
  liveValueProblem,
  overlayBoundsFace,
  pinnedCardReadout,
} from './controlFaces';

const topic = { kind: 'topic' as const, text: 'rust lifetimes' };

describe('liveValueProblem', () => {
  test('an unread value says so', () => {
    expect(liveValueProblem({ status: 'failed', stale: false }, 'the pinned card')).toBe('Could not read the pinned card.');
  });

  // The reconnect refetch failing used to be silent: the controls looked current.
  test('a known value whose refresh failed says it is last known', () => {
    expect(liveValueProblem({ status: 'loaded', stale: true }, 'the pinned card')).toMatch(/last known/);
  });

  test('a current value has no problem', () => {
    expect(liveValueProblem({ status: 'loaded', stale: false }, 'x')).toBeNull();
    expect(liveValueProblem({ status: 'loading', stale: false }, 'x')).toBeNull();
  });
});

describe('pinned card and countdown readouts', () => {
  // The bug: a failed GET read as "nothing pinned" while a card was on stream.
  test('an unread card is not "nothing pinned"', () => {
    expect(pinnedCardReadout('failed', null).text).not.toMatch(/nothing pinned/);
    expect(pinnedCardReadout('loading', null).text).not.toMatch(/nothing pinned/);
    expect(pinnedCardReadout('loaded', null)).toEqual({ text: 'nothing pinned', empty: true });
    expect(pinnedCardReadout('loaded', topic)).toEqual({ text: 'topic: rust lifetimes', empty: false });
  });

  test('an unread countdown is not "none set"', () => {
    expect(holdingReadoutText('failed', null, '—')).toBe('unknown');
    expect(holdingReadoutText('loading', null, '—')).not.toBe('—');
    expect(holdingReadoutText('loaded', null, '—')).toBe('—');
    expect(holdingReadoutText('loaded', '04:59', '—')).toBe('04:59');
  });

  // Clear disabled on an unknown value left the operator unable to take a card down.
  test('clear stays offered while the value is unknown', () => {
    expect(clearOffered('failed', false)).toBe(true);
    expect(clearOffered('loading', false)).toBe(true);
    expect(clearOffered('loaded', false)).toBe(false);
    expect(clearOffered('loaded', true)).toBe(true);
  });
});

describe('overlayBoundsFace', () => {
  // The browser source fails closed to "off"; the operator's switch must not show that.
  test('an unread state is neither ticked nor silently unticked', () => {
    const face = overlayBoundsFace('failed', false);
    expect(face.checked).toBe(false);
    expect(face.locked).toBe(true);
    expect(face.unreadable).toMatch(/could not read/i);
  });

  test('a known state draws as itself, and warns while on', () => {
    expect(overlayBoundsFace('loaded', true)).toEqual({ checked: true, locked: false, warn: true, unreadable: null });
    expect(overlayBoundsFace('loaded', false)).toEqual({ checked: false, locked: false, warn: false, unreadable: null });
  });

  test('the switch takes no input while the state is loading', () => {
    expect(overlayBoundsFace('loading', false).locked).toBe(true);
  });
});
