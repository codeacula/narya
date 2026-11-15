import { describe, expect, test } from 'bun:test';
import { createLatestOnly } from './latestOnly';

describe('createLatestOnly', () => {
  test('a lone request is current', () => {
    const gate = createLatestOnly();
    const isCurrent = gate.begin();
    expect(isCurrent()).toBe(true);
  });

  test('a request started later supersedes an earlier one, whichever settles first', () => {
    const gate = createLatestOnly();
    const slowFailure = gate.begin();
    const retry = gate.begin();
    // The retry settles first and applies; the slow failure lands after and must not.
    expect(retry()).toBe(true);
    expect(slowFailure()).toBe(false);
  });

  test('gates are independent of one another', () => {
    const a = createLatestOnly();
    const b = createLatestOnly();
    const first = a.begin();
    b.begin();
    expect(first()).toBe(true);
  });
});
