import { describe, expect, test } from 'bun:test';
import { INITIAL_REFRESH_HEALTH, isStale, recordRefresh, staleNoticeText } from './refreshHealth';

describe('refresh health', () => {
  test('a list that never loaded is not stale, however often it fails', () => {
    let health = INITIAL_REFRESH_HEALTH;
    health = recordRefresh(health, false, 1_000);
    health = recordRefresh(health, false, 2_000);
    expect(health.consecutiveFailures).toBe(2);
    expect(isStale(health)).toBe(false);
    expect(staleNoticeText(health)).toBeNull();
  });

  test('a failure after a success marks the list stale and keeps the success time', () => {
    let health = recordRefresh(INITIAL_REFRESH_HEALTH, true, 5_000);
    expect(isStale(health)).toBe(false);
    health = recordRefresh(health, false, 9_000);
    expect(isStale(health)).toBe(true);
    expect(health.lastSuccessAt).toBe(5_000);
    health = recordRefresh(health, false, 12_000);
    expect(health).toEqual({ lastSuccessAt: 5_000, consecutiveFailures: 2 });
  });

  test('the next success clears the marker', () => {
    let health = recordRefresh(INITIAL_REFRESH_HEALTH, true, 5_000);
    health = recordRefresh(health, false, 9_000);
    health = recordRefresh(health, true, 14_000);
    expect(health).toEqual({ lastSuccessAt: 14_000, consecutiveFailures: 0 });
    expect(staleNoticeText(health)).toBeNull();
  });

  test('the marker says how old the list is', () => {
    const twoMinutesAgo = Date.now() - 2 * 60_000 - 5_000;
    const health = recordRefresh(recordRefresh(INITIAL_REFRESH_HEALTH, true, twoMinutesAgo), false, Date.now());
    expect(staleNoticeText(health)).toBe("Couldn't refresh · last updated 2m ago");
  });
});
