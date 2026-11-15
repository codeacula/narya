import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import { formatAgo } from './time';

const NOW = new Date('2026-11-14T18:00:00.000Z');
const ago = (secs: number) => new Date(NOW.getTime() - secs * 1000).toISOString();

describe('formatAgo', () => {
  afterEach(() => setSystemTime());

  test('every bucket carries a unit, so an age never reads as a clock time', () => {
    setSystemTime(NOW);
    expect(formatAgo(ago(30))).toBe('just now');
    expect(formatAgo(ago(15 * 60 + 27))).toBe('15m ago');
    expect(formatAgo(ago(59 * 60 + 59))).toBe('59m ago');
    expect(formatAgo(ago(2 * 3600))).toBe('2h ago');
    expect(formatAgo(ago(2 * 3600 + 5 * 60))).toBe('2h 5m ago');
    expect(formatAgo(ago(3 * 86_400))).toBe('3d ago');
    expect(formatAgo(ago(65 * 86_400))).toBe('2mo ago');
  });

  test('never renders the old m:ss form', () => {
    setSystemTime(NOW);
    for (const secs of [61, 600, 1527, 3599]) expect(formatAgo(ago(secs))).not.toMatch(/^\d+:\d\d$/);
  });

  test('a future timestamp (clock skew) clamps to just now', () => {
    setSystemTime(NOW);
    expect(formatAgo(new Date(NOW.getTime() + 5000).toISOString())).toBe('just now');
  });
});
