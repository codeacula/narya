import { afterEach, expect, test } from 'bun:test';
import { getOverlayPlaceholders, setOverlayPlaceholders } from './overlayPlaceholders';

afterEach(() => { setOverlayPlaceholders({ enabled: false }); });

// The whole point of the flag being in memory: boxes drawn over a live stream are the
// bad state, so a fresh process must never start in it.
test('starts off', () => {
  expect(getOverlayPlaceholders()).toEqual({ enabled: false });
});

test('toggles on and back off', () => {
  expect(setOverlayPlaceholders({ enabled: true })).toEqual({ enabled: true });
  expect(getOverlayPlaceholders()).toEqual({ enabled: true });
  expect(setOverlayPlaceholders({ enabled: false })).toEqual({ enabled: false });
});

// Fail closed. A malformed or truthy-ish body must not be able to switch the boxes on
// by accident — only a literal `true` does.
test('only a literal true enables it', () => {
  for (const body of [{}, null, undefined, { enabled: 'true' }, { enabled: 1 }, 'yes'] as unknown[]) {
    expect(setOverlayPlaceholders(body)).toEqual({ enabled: false });
  }
});
