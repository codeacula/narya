import { expect, test } from 'bun:test';
import { getOverlayAdBreak } from './overlayAds';

const NOW = Date.parse('2026-07-07T12:00:00.000Z');

test('a running break reports only its end time', () => {
  expect(getOverlayAdBreak({ adBreakEndsAt: '2026-07-07T12:02:17.000Z' }, NOW)).toEqual({ endsAt: '2026-07-07T12:02:17.000Z' });
});

test('no break, a past end time, an end time of exactly now, and garbage are all null', () => {
  expect(getOverlayAdBreak({ adBreakEndsAt: null }, NOW)).toEqual({ endsAt: null });
  expect(getOverlayAdBreak({ adBreakEndsAt: '2026-07-07T11:59:59.000Z' }, NOW)).toEqual({ endsAt: null });
  expect(getOverlayAdBreak({ adBreakEndsAt: '2026-07-07T12:00:00.000Z' }, NOW)).toEqual({ endsAt: null });
  expect(getOverlayAdBreak({ adBreakEndsAt: 'not a date' }, NOW)).toEqual({ endsAt: null });
});
