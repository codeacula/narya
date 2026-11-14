import { expect, test } from 'bun:test';
import { formatCountdown } from './countdown';

test('formats the mockup value', () => {
  expect(formatCountdown(150_000)).toBe('02:30');
});

test('rounds up while time remains, so it never shows a second too few', () => {
  expect(formatCountdown(59_001)).toBe('01:00');
  expect(formatCountdown(60_000)).toBe('01:00');
  expect(formatCountdown(60_001)).toBe('01:01');
  expect(formatCountdown(1)).toBe('00:01');
});

test('zero is 00:00', () => {
  expect(formatCountdown(0)).toBe('00:00');
});

test('switches to h:mm:ss at an hour', () => {
  expect(formatCountdown(3_599_000)).toBe('59:59');
  expect(formatCountdown(3_599_500)).toBe('1:00:00');
  expect(formatCountdown(3_600_000)).toBe('1:00:00');
  expect(formatCountdown(3_661_000)).toBe('1:01:01');
});

test('counts into negatives with whole elapsed seconds and never -00:00', () => {
  expect(formatCountdown(-1)).toBe('00:00');
  expect(formatCountdown(-999)).toBe('00:00');
  expect(formatCountdown(-1_000)).toBe('-00:01');
  expect(formatCountdown(-135_000)).toBe('-02:15');
  expect(formatCountdown(-135_500)).toBe('-02:15');
  expect(formatCountdown(-3_600_000)).toBe('-1:00:00');
});

test('non-finite input reads 00:00', () => {
  expect(formatCountdown(Number.NaN)).toBe('00:00');
  expect(formatCountdown(Number.POSITIVE_INFINITY)).toBe('00:00');
});
