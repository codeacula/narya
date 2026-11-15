import { describe, expect, test } from 'bun:test';
import { createWriteGuard, nextLiveValueStatus } from './liveValue';

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
