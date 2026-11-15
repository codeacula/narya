import { describe, expect, test } from 'bun:test';
import { INITIAL_LIVE_VALUE_HEALTH, createWriteGuard, nextLiveValueHealth, nextLiveValueStatus } from './liveValue';

describe('createWriteGuard', () => {
  test('a fetch with no write since it started is current', () => {
    const guard = createWriteGuard();
    const isCurrent = guard.begin();
    expect(isCurrent()).toBe(true);
  });

  // The race: REST request starts, a socket event lands, then the (older) response arrives.
  test('a write after the fetch started makes the fetch stale', () => {
    const guard = createWriteGuard();
    const isCurrent = guard.begin();
    guard.bump();
    expect(isCurrent()).toBe(false);
  });

  test('a fetch started after the write is current again', () => {
    const guard = createWriteGuard();
    guard.bump();
    expect(guard.begin()()).toBe(true);
  });
});

describe('nextLiveValueStatus', () => {
  test('a first fetch that fails leaves the value unknown, not "loaded"', () => {
    expect(nextLiveValueStatus('loading', 'fetch-failed')).toBe('failed');
  });

  test('a fetch or a write makes the value known', () => {
    expect(nextLiveValueStatus('loading', 'fetched')).toBe('loaded');
    expect(nextLiveValueStatus('failed', 'written')).toBe('loaded');
  });

  // A reconnect refetch that fails must not hide a value the server already gave us.
  test('a later failure keeps a known value known', () => {
    expect(nextLiveValueStatus('loaded', 'fetch-failed')).toBe('loaded');
  });

  test('a retry goes back to loading only from a failure', () => {
    expect(nextLiveValueStatus('failed', 'retry')).toBe('loading');
    expect(nextLiveValueStatus('loaded', 'retry')).toBe('loaded');
  });
});

describe('nextLiveValueHealth', () => {
  const loaded = { status: 'loaded' as const, stale: false };

  // The reconnect refetch failed: the value is kept, but it is only last-known now.
  test('a failed refetch of a known value marks it stale, and keeps it known', () => {
    expect(nextLiveValueHealth(loaded, 'fetch-failed')).toEqual({ status: 'loaded', stale: true });
  });

  test('a first fetch that fails is unknown, not stale', () => {
    expect(nextLiveValueHealth(INITIAL_LIVE_VALUE_HEALTH, 'fetch-failed')).toEqual({ status: 'failed', stale: false });
  });

  test('a fetch or a write that lands clears stale', () => {
    const stale = { status: 'loaded' as const, stale: true };
    expect(nextLiveValueHealth(stale, 'fetched').stale).toBe(false);
    expect(nextLiveValueHealth(stale, 'written').stale).toBe(false);
  });

  test('a retry keeps stale until its fetch settles', () => {
    expect(nextLiveValueHealth({ status: 'loaded', stale: true }, 'retry')).toEqual({ status: 'loaded', stale: true });
  });
});
