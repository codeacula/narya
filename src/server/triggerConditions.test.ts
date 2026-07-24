import { describe, expect, test } from 'bun:test';
import { CONDITIONS_UNREADABLE, evaluateConditions } from './triggerConditions';
import type { TemplateContext, TriggerCondition } from '../shared/api';

const ctx = (over: Partial<TemplateContext>): TemplateContext => over;

describe('evaluateConditions', () => {
  test('empty conditions always pass', () => {
    expect(evaluateConditions([], ctx({}))).toBe(true);
  });
  test('eq / contains / starts_with are case-insensitive', () => {
    expect(evaluateConditions([{ field: 'actor', op: 'eq', value: 'Bob' }], ctx({ actor: 'bob' }))).toBe(true);
    expect(evaluateConditions([{ field: 'message', op: 'contains', value: 'HELLO' }], ctx({ message: 'oh hello there' }))).toBe(true);
    expect(evaluateConditions([{ field: 'input', op: 'starts_with', value: '!go' }], ctx({ input: '!GO now' }))).toBe(true);
  });
  test('gte / lte coerce; NaN → false', () => {
    expect(evaluateConditions([{ field: 'amount', op: 'gte', value: 100 }], ctx({ amount: 150 }))).toBe(true);
    expect(evaluateConditions([{ field: 'amount', op: 'gte', value: 100 }], ctx({ amount: 50 }))).toBe(false);
    expect(evaluateConditions([{ field: 'tier', op: 'gte', value: 2 }], ctx({ tier: 'notanumber' }))).toBe(false);
  });
  test('in membership (case-insensitive)', () => {
    expect(evaluateConditions([{ field: 'tier', op: 'in', value: ['1000', '3000'] }], ctx({ tier: '3000' }))).toBe(true);
    expect(evaluateConditions([{ field: 'tier', op: 'in', value: ['1000'] }], ctx({ tier: '3000' }))).toBe(false);
  });
  test('AND across multiple; one failure fails all', () => {
    expect(evaluateConditions([{ field: 'amount', op: 'gte', value: 100 }, { field: 'actor', op: 'eq', value: 'bob' }], ctx({ amount: 150, actor: 'bob' }))).toBe(true);
    expect(evaluateConditions([{ field: 'amount', op: 'gte', value: 100 }, { field: 'actor', op: 'eq', value: 'bob' }], ctx({ amount: 150, actor: 'ann' }))).toBe(false);
  });
  test('missing field → false for EVERY op, including neq', () => {
    for (const op of ['eq', 'neq', 'contains', 'starts_with', 'gte', 'lte', 'in'] as const) {
      const value = op === 'in' ? ['x'] : op === 'gte' || op === 'lte' ? 1 : 'x';
      expect(evaluateConditions([{ field: 'amount', op, value }], ctx({}))).toBe(false);
    }
  });
  test('role_is / tag_has read the resolved sets; empty → never pass', () => {
    expect(evaluateConditions([{ field: 'role', op: 'role_is', value: 'sub' }], ctx({ roles: ['sub', 'vip'] }))).toBe(true);
    expect(evaluateConditions([{ field: 'role', op: 'role_is', value: 'mod' }], ctx({ roles: ['sub'] }))).toBe(false);
    expect(evaluateConditions([{ field: 'role', op: 'role_is', value: 'sub' }], ctx({}))).toBe(false);
    expect(evaluateConditions([{ field: 'tags', op: 'tag_has', value: 'Friend' }], ctx({ tags: ['friend'] }))).toBe(true); // normalized
  });
  test('the unreadable sentinel fails closed', () => {
    expect(evaluateConditions(CONDITIONS_UNREADABLE, ctx({ actor: 'bob' }))).toBe(false);
  });
  test('a non-array conditions value fails closed without throwing', () => {
    // A syntactically-valid-but-non-array conditions_json (e.g. {} or "x", reachable
    // via manual DB tampering) must fail closed rather than throw on `.every`.
    for (const bad of [{}, 'x', 42, null, undefined] as unknown[]) {
      expect(evaluateConditions(bad as TriggerCondition[], ctx({ actor: 'bob' }))).toBe(false);
    }
  });
  test('unknown op → false', () => {
    expect(evaluateConditions([{ field: 'actor', op: 'wat' as never, value: 'x' }], ctx({ actor: 'x' }))).toBe(false);
  });

  test('a data.* field reads the nested payload', () => {
    const data = { data: { boss: 'Dragon', wave: 7 } } as unknown as TemplateContext;
    expect(evaluateConditions([{ field: 'data.boss', op: 'eq', value: 'dragon' }], data)).toBe(true);
    expect(evaluateConditions([{ field: 'data.wave', op: 'gte', value: 5 }], data)).toBe(true);
    expect(evaluateConditions([{ field: 'data.wave', op: 'gte', value: 9 }], data)).toBe(false);
  });

  test('a missing data key fails closed for every op including neq', () => {
    const data = { data: { boss: 'Dragon' } } as unknown as TemplateContext;
    expect(evaluateConditions([{ field: 'data.nope', op: 'neq', value: 'x' }], data)).toBe(false);
  });

  test('a data.* condition on a context with no data fails closed', () => {
    expect(evaluateConditions([{ field: 'data.boss', op: 'eq', value: 'x' }], {} as TemplateContext)).toBe(false);
  });

  test('a non-scalar data value compares as its JSON form, never [object Object]', () => {
    const data = { data: { loot: { rare: true } } } as unknown as TemplateContext;
    expect(evaluateConditions([{ field: 'data.loot', op: 'contains', value: 'rare' }], data)).toBe(true);
    expect(evaluateConditions([{ field: 'data.loot', op: 'contains', value: 'object' }], data)).toBe(false);
  });
});
