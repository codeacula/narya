import { describe, expect, test } from 'bun:test';
import { INITIAL_REFRESH_HEALTH, isStale, loadPhase, recordRefresh, staleNoticeText } from './refreshHealth';

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

describe('loadPhase', () => {
  test('nothing attempted yet is loading, not empty', () => {
    expect(loadPhase(INITIAL_REFRESH_HEALTH)).toBe('loading');
  });

  test('only failures so far is failed, however many', () => {
    let health = recordRefresh(INITIAL_REFRESH_HEALTH, false, 1_000);
    expect(loadPhase(health)).toBe('failed');
    health = recordRefresh(health, false, 2_000);
    expect(loadPhase(health)).toBe('failed');
  });

  test('a success is fresh, a failure after it is stale, and the next success clears it', () => {
    let health = recordRefresh(INITIAL_REFRESH_HEALTH, false, 1_000);
    health = recordRefresh(health, true, 2_000);
    expect(loadPhase(health)).toBe('fresh');
    health = recordRefresh(health, false, 3_000);
    expect(loadPhase(health)).toBe('stale');
    expect(loadPhase(recordRefresh(health, true, 4_000))).toBe('fresh');
  });
});
