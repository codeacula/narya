import { beforeEach, describe, expect, test } from 'bun:test';
import { db } from './db';
import { HttpRouteError } from './http';
import {
  MAX_NEXT_STREAM_LENGTH,
  adjustHoldingCountdown,
  getHoldingScenes,
  setHoldingCountdown,
  setNextStream,
} from './holdingScenes';

const NOW = Date.parse('2026-11-14T12:00:00.000Z');
const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();

function statusOf(fn: () => unknown): number | null {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof HttpRouteError ? error.status : -1;
  }
}

beforeEach(() => {
  db.exec('delete from holding_scenes');
});

describe('holding scene state', () => {
  test('starts empty and carries only the declared fields', () => {
    expect(getHoldingScenes()).toEqual({ startingEndsAt: null, brbEndsAt: null, nextStream: '' });
    setHoldingCountdown('brb', 10, NOW);
    setNextStream('Friday 7pm', NOW);
    expect(Object.keys(getHoldingScenes()).sort()).toEqual(['brbEndsAt', 'nextStream', 'startingEndsAt']);
  });

  test('sets each scene independently from the server clock and clears with null', () => {
    setHoldingCountdown('starting', 5, NOW);
    expect(getHoldingScenes()).toMatchObject({ startingEndsAt: at(5), brbEndsAt: null });
    setHoldingCountdown('brb', 15, NOW);
    expect(getHoldingScenes()).toMatchObject({ startingEndsAt: at(5), brbEndsAt: at(15) });
    setHoldingCountdown('starting', null, NOW);
    expect(getHoldingScenes()).toMatchObject({ startingEndsAt: null, brbEndsAt: at(15) });
  });

  test('accepts the bounds and rejects values just outside them', () => {
    expect(statusOf(() => setHoldingCountdown('brb', 1, NOW))).toBeNull();
    expect(statusOf(() => setHoldingCountdown('brb', 240, NOW))).toBeNull();
    for (const bad of [0, 241, -5, Number.NaN, Infinity, 7.5, '10', undefined, {}]) {
      expect(statusOf(() => setHoldingCountdown('brb', bad, NOW))).toBe(400);
    }
    // A rejected write leaves the last good value alone.
    expect(getHoldingScenes().brbEndsAt).toBe(at(240));
  });

  test('rejects an unknown scene', () => {
    for (const bad of ['ending', '', 7, null, undefined]) {
      expect(statusOf(() => setHoldingCountdown(bad, 5, NOW))).toBe(400);
      expect(statusOf(() => adjustHoldingCountdown(bad, 5, NOW))).toBe(400);
    }
  });
});

describe('adjusting a countdown', () => {
  test('moves the end time by whole minutes either way', () => {
    setHoldingCountdown('brb', 10, NOW);
    adjustHoldingCountdown('brb', 5, NOW);
    expect(getHoldingScenes().brbEndsAt).toBe(at(15));
    adjustHoldingCountdown('brb', -5, NOW);
    adjustHoldingCountdown('brb', -5, NOW);
    expect(getHoldingScenes().brbEndsAt).toBe(at(5));
  });

  test('an unset countdown is a 409, not a new countdown', () => {
    expect(statusOf(() => adjustHoldingCountdown('starting', 5, NOW))).toBe(409);
    expect(getHoldingScenes().startingEndsAt).toBeNull();
  });

  test('may run an overdue countdown further into the past, and back out', () => {
    setHoldingCountdown('brb', 1, NOW);
    adjustHoldingCountdown('brb', -5, NOW);
    expect(getHoldingScenes().brbEndsAt).toBe(at(-4));
    adjustHoldingCountdown('brb', 5, NOW);
    expect(getHoldingScenes().brbEndsAt).toBe(at(1));
  });

  test('clamps so repeated nudges cannot leave the settable range', () => {
    setHoldingCountdown('starting', 240, NOW);
    adjustHoldingCountdown('starting', 240, NOW);
    expect(getHoldingScenes().startingEndsAt).toBe(at(240));
    for (let i = 0; i < 4; i += 1) adjustHoldingCountdown('starting', -240, NOW);
    expect(getHoldingScenes().startingEndsAt).toBe(at(-240));
  });

  test('rejects zero, out-of-range, fractional and non-numeric deltas', () => {
    setHoldingCountdown('brb', 10, NOW);
    for (const bad of [0, 241, -241, Number.NaN, 2.5, '5', null, undefined]) {
      expect(statusOf(() => adjustHoldingCountdown('brb', bad, NOW))).toBe(400);
    }
    expect(getHoldingScenes().brbEndsAt).toBe(at(10));
  });
});

describe('next stream text', () => {
  test('is trimmed, capped, and empty clears it', () => {
    setNextStream('  Friday at 7pm  ', NOW);
    expect(getHoldingScenes().nextStream).toBe('Friday at 7pm');
    setNextStream('x'.repeat(MAX_NEXT_STREAM_LENGTH + 50), NOW);
    expect(getHoldingScenes().nextStream).toHaveLength(MAX_NEXT_STREAM_LENGTH);
    setNextStream('   ', NOW);
    expect(getHoldingScenes().nextStream).toBe('');
  });

  test('rejects a non-string', () => {
    for (const bad of [undefined, null, 5, {}]) {
      expect(statusOf(() => setNextStream(bad, NOW))).toBe(400);
    }
  });

  test('does not disturb a running countdown', () => {
    setHoldingCountdown('brb', 10, NOW);
    setNextStream('soon', NOW);
    expect(getHoldingScenes().brbEndsAt).toBe(at(10));
  });
});
