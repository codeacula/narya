import { describe, expect, test } from 'bun:test';
import { createWriteGuard } from './liveValue';

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
