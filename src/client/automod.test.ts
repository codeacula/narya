import { describe, expect, test } from 'bun:test';
import type { AutomodHold } from '../shared/api';
import { appendPendingHold } from './automod';

function hold(id: string): AutomodHold {
  return {
    id,
    channel: 'codeacula',
    username: id,
    displayName: id,
    message: `message ${id}`,
    category: null,
    level: null,
    heldAt: id,
    resolvedAt: null,
    resolution: null,
    resolvedBy: null,
  };
}

describe('appendPendingHold', () => {
  test('appends to the end, keeping oldest-first order', () => {
    const current = [hold('a'), hold('b')];
    expect(appendPendingHold(current, hold('c'), 200).map(h => h.id)).toEqual(['a', 'b', 'c']);
  });

  test('ignores a hold already present', () => {
    const current = [hold('a'), hold('b')];
    expect(appendPendingHold(current, hold('a'), 200)).toBe(current);
  });

  test('evicts the OLDEST entry once the limit is exceeded, keeping the newest arrival', () => {
    const current = Array.from({ length: 200 }, (_, i) => hold(String(i)));
    const result = appendPendingHold(current, hold('new'), 200);
    expect(result.length).toBe(200);
    expect(result[result.length - 1]?.id).toBe('new');
    expect(result[0]?.id).toBe('1');
    expect(result.some(h => h.id === '0')).toBe(false);
  });
});
