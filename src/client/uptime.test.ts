import { expect, test } from 'bun:test';
import { formatUptime, uptimeSince } from './uptime';

test('formats the mockup value', () => {
  expect(formatUptime((1 * 60 + 24) * 60_000 + 7_000)).toBe('01:24:07');
});

test('pads and rolls over at the unit boundaries', () => {
  expect(formatUptime(0)).toBe('00:00:00');
  expect(formatUptime(999)).toBe('00:00:00');
  expect(formatUptime(1_000)).toBe('00:00:01');
  expect(formatUptime(59_000)).toBe('00:00:59');
  expect(formatUptime(60_000)).toBe('00:01:00');
  expect(formatUptime(3_599_000)).toBe('00:59:59');
  expect(formatUptime(3_600_000)).toBe('01:00:00');
});

test('keeps counting hours past a day instead of wrapping', () => {
  expect(formatUptime(25 * 3_600_000 + 61_000)).toBe('25:01:01');
  expect(formatUptime(100 * 3_600_000)).toBe('100:00:00');
});

test('clamps negative (clock-skew) and non-finite elapsed time to zero', () => {
  expect(formatUptime(-5_000)).toBe('00:00:00');
  expect(formatUptime(Number.NaN)).toBe('00:00:00');
  expect(formatUptime(Number.POSITIVE_INFINITY)).toBe('00:00:00');
});

test('uptimeSince measures from the start stamp and hides when there is none', () => {
  const start = '2026-03-01T12:00:00.000Z';
  const now = new Date('2026-03-01T13:24:07.500Z').getTime();
  expect(uptimeSince(start, now)).toBe('01:24:07');
  expect(uptimeSince(start, new Date('2026-03-01T11:59:00.000Z').getTime())).toBe('00:00:00');
  expect(uptimeSince(null, now)).toBeNull();
  expect(uptimeSince('not a date', now)).toBeNull();
});
