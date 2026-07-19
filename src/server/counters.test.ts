import { beforeEach, describe, expect, test } from 'bun:test';
import {
  adjustCounter,
  adjustCounterByKey,
  createCounter,
  deleteCounter,
  findCounterByKey,
  getCounterValue,
  listCounters,
  normalizeCounterKey,
  parseCounterAmount,
  updateCounter,
} from './counters';
import { db } from './db';
import { HttpRouteError } from './http';

function reset() {
  db.exec('delete from counters');
  db.exec('delete from action_steps');
  db.exec('delete from actions');
  db.exec('delete from stream_status');
}

function counter(overrides: Partial<{ key: string; label: string; value: number }> = {}) {
  return createCounter({ key: 'deaths', label: 'Deaths', value: 0, ...overrides });
}

/** A stored step, so the delete guard has something real to find. */
function step(stepType: string, payload: unknown, actionName = 'Death alert', actionId = 'action-1') {
  db.prepare('insert or ignore into actions (id, name, description, enabled, quick_disable, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)')
    .run(actionId, actionName, '', 1, 0, '2026-07-19T00:00:00.000Z', '2026-07-19T00:00:00.000Z');
  db.prepare(`
    insert into action_steps (id, action_id, position, step_type, payload_json, delay_ms, enabled, created_at, updated_at)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(crypto.randomUUID(), actionId, 0, stepType, JSON.stringify(payload), 0, 1, '2026-07-19T00:00:00.000Z', '2026-07-19T00:00:00.000Z');
}

beforeEach(reset);

describe('normalizeCounterKey', () => {
  test('lowercases, hyphenates whitespace and underscores, and drops the rest', () => {
    expect(normalizeCounterKey('Zambie Deaths!')).toBe('zambie-deaths');
    expect(normalizeCounterKey('total_wipes')).toBe('total-wipes');
    expect(normalizeCounterKey('  spaced   out  ')).toBe('spaced-out');
  });

  test('collapses runs of hyphens and trims them from the ends', () => {
    expect(normalizeCounterKey('--a---b--')).toBe('a-b');
  });

  test('returns empty for a key with nothing usable in it', () => {
    expect(normalizeCounterKey('!!!')).toBe('');
    expect(normalizeCounterKey('')).toBe('');
    expect(normalizeCounterKey(null)).toBe('');
  });
});

describe('createCounter', () => {
  test('normalizes the key on write, so the stored token is the one to type', () => {
    expect(counter({ key: 'Zambie Deaths!' }).key).toBe('zambie-deaths');
  });

  test('rejects a key that normalizes to nothing', () => {
    expect(() => counter({ key: '!!!' })).toThrow(HttpRouteError);
  });

  test('rejects a blank label', () => {
    expect(() => counter({ label: '   ' })).toThrow(HttpRouteError);
  });

  test('rejects a duplicate key rather than hitting the unique constraint raw', () => {
    counter({ key: 'deaths' });
    expect(() => counter({ key: 'Deaths', label: 'Other' })).toThrow(HttpRouteError);
  });

  test('seeds a starting value', () => {
    expect(counter({ value: 41 }).value).toBe(41);
  });
});

describe('adjustCounter', () => {
  test('add moves the value; set assigns it', () => {
    const created = counter({ value: 41 });
    expect(adjustCounter(created.id, 'add', 1)!.value).toBe(42);
    expect(adjustCounter(created.id, 'set', 7)!.value).toBe(7);
  });

  test('goes negative rather than clamping at zero', () => {
    const created = counter({ value: 1 });
    expect(adjustCounter(created.id, 'add', -5)!.value).toBe(-4);
  });

  test('a set of 0 is how a reset is expressed', () => {
    const created = counter({ value: 99 });
    expect(adjustCounter(created.id, 'set', 0)!.value).toBe(0);
  });

  test('returns null for an unknown id instead of throwing, so the step can skip', () => {
    expect(adjustCounter('nope', 'add', 1)).toBeNull();
  });

  test('adjustCounterByKey resolves through the key', () => {
    counter({ key: 'deaths', value: 3 });
    expect(adjustCounterByKey('deaths', 'add', 2)!.value).toBe(5);
    expect(adjustCounterByKey('missing', 'add', 1)).toBeNull();
  });
});

describe('getCounterValue', () => {
  test('distinguishes a counter at zero from a counter that does not exist', () => {
    counter({ key: 'deaths', value: 0 });
    // The distinction the renderer depends on: 0 renders as "0", undefined renders
    // the token literally.
    expect(getCounterValue('deaths')).toBe(0);
    expect(getCounterValue('nope')).toBeUndefined();
  });
});

describe('updateCounter', () => {
  test('a partial body that renames does not reset the count', () => {
    const created = counter({ value: 12 });
    expect(updateCounter(created.id, { label: 'Renamed' }).value).toBe(12);
  });

  test('rejects taking a key another counter already holds', () => {
    counter({ key: 'deaths' });
    const other = counter({ key: 'wipes', label: 'Wipes' });
    expect(() => updateCounter(other.id, { key: 'deaths' })).toThrow(HttpRouteError);
  });

  test('keeping its own key is not a collision with itself', () => {
    const created = counter({ key: 'deaths' });
    expect(updateCounter(created.id, { key: 'deaths', label: 'Deaths!' }).label).toBe('Deaths!');
  });

  test('404s for an unknown id', () => {
    expect(() => updateCounter('nope', { label: 'x' })).toThrow(HttpRouteError);
  });
});

describe('deleteCounter', () => {
  test('removes an unreferenced counter', () => {
    const created = counter();
    deleteCounter(created.id);
    expect(listCounters()).toHaveLength(0);
  });

  test('refuses when an adjust_counter step still names it', () => {
    const created = counter();
    step('adjust_counter', { counterId: created.id, mode: 'add', amountTemplate: '1' });
    expect(() => deleteCounter(created.id)).toThrow(HttpRouteError);
  });

  test('refuses when any step template still interpolates it', () => {
    // The asymmetry this guards: an unknown counter key renders LITERALLY, so
    // deleting this would put a raw "{counter:deaths}" on the live stream.
    const created = counter({ key: 'deaths' });
    step('show_text', { template: 'Deaths: {counter:deaths}', durationMs: 5000, style: 'banner' });
    expect(() => deleteCounter(created.id)).toThrow(HttpRouteError);
  });

  test('refuses when the stream status line interpolates it', () => {
    const created = counter({ key: 'deaths' });
    db.prepare('insert into stream_status (id, text, raw_text, updated_at) values (?, ?, ?, ?)')
      .run('default', 'Deaths: 3', 'Deaths: {counter:deaths}', '2026-07-19T00:00:00.000Z');
    expect(() => deleteCounter(created.id)).toThrow(HttpRouteError);
  });

  test('a step referencing a different counter does not block the delete', () => {
    const created = counter({ key: 'deaths' });
    const other = counter({ key: 'wipes', label: 'Wipes' });
    step('adjust_counter', { counterId: other.id, mode: 'add', amountTemplate: '1' });
    deleteCounter(created.id);
    expect(listCounters().map(entry => entry.key)).toEqual(['wipes']);
  });

  test('a template naming a similar-but-different key does not block the delete', () => {
    const created = counter({ key: 'deaths' });
    counter({ key: 'deaths-today', label: 'Today' });
    step('show_text', { template: '{counter:deaths-today}', durationMs: 5000, style: 'banner' });
    // Substring matching would wrongly see "{counter:deaths" inside the other token.
    deleteCounter(created.id);
    expect(findCounterByKey('deaths')).toBeNull();
  });

  test('404s for an unknown id', () => {
    expect(() => deleteCounter('nope')).toThrow(HttpRouteError);
  });
});

describe('listCounters', () => {
  test('sorts by label', () => {
    counter({ key: 'wipes', label: 'Wipes' });
    counter({ key: 'deaths', label: 'Deaths' });
    expect(listCounters().map(entry => entry.label)).toEqual(['Deaths', 'Wipes']);
  });
});

describe('renaming a key', () => {
  test('is blocked while a template still names the old key', () => {
    // A rename is a delete for every {counter:key} that names the old key: the
    // token stops resolving and starts rendering literally on the live overlay.
    const created = counter({ key: 'deaths' });
    step('show_text', { template: 'Deaths: {counter:deaths}', durationMs: 5000, style: 'banner' });
    expect(() => updateCounter(created.id, { key: 'zombie-deaths' })).toThrow(HttpRouteError);
    expect(findCounterByKey('deaths')).not.toBeNull();
  });

  test('is blocked while the stream status still names the old key', () => {
    const created = counter({ key: 'deaths' });
    db.prepare('insert into stream_status (id, text, raw_text, updated_at) values (?, ?, ?, ?)')
      .run('default', 'Deaths: 3', 'Deaths: {counter:deaths}', '2026-07-19T00:00:00.000Z');
    expect(() => updateCounter(created.id, { key: 'zombie-deaths' })).toThrow(HttpRouteError);
  });

  test('is allowed when nothing references the counter', () => {
    const created = counter({ key: 'deaths' });
    expect(updateCounter(created.id, { key: 'zombie-deaths' }).key).toBe('zombie-deaths');
  });

  test('an adjust_counter step alone does not block a rename, since it binds the id', () => {
    const created = counter({ key: 'deaths' });
    step('adjust_counter', { counterId: created.id, mode: 'add', amountTemplate: '1' });
    expect(updateCounter(created.id, { key: 'zombie-deaths' }).key).toBe('zombie-deaths');
  });

  test('renaming label and value without touching the key is never blocked', () => {
    const created = counter({ key: 'deaths' });
    step('show_text', { template: '{counter:deaths}', durationMs: 5000, style: 'banner' });
    expect(updateCounter(created.id, { label: 'Renamed' }).label).toBe('Renamed');
  });
});

describe('the delete-conflict message', () => {
  test('names only the Actions that reference this counter', () => {
    const created = counter({ key: 'deaths' });
    const other = counter({ key: 'wipes', label: 'Wipes' });
    step('adjust_counter', { counterId: created.id, mode: 'add', amountTemplate: '1' }, 'Death alert', 'action-1');
    step('adjust_counter', { counterId: other.id, mode: 'add', amountTemplate: '1' }, 'Wipe alert', 'action-2');

    // The old query filtered on step_type alone, so it named every Action holding
    // any adjust_counter step and sent the operator to edit unrelated ones.
    try {
      deleteCounter(created.id);
      throw new Error('expected a conflict');
    } catch (caught) {
      const message = (caught as Error).message;
      expect(message).toContain('Death alert');
      expect(message).not.toContain('Wipe alert');
    }
  });
});

describe('parseCounterAmount', () => {
  /**
   * The rule every runtime adjustment shares. An amount can be bound from
   * untrusted input — "!death {arg1}" puts a viewer's chat text here — and 1e308
   * is finite, so an isFinite-only check let it reach clampValue, which pinned the
   * counter to MAX_SAFE_INTEGER. There is no counter history, so that destroyed
   * the tally unrecoverably.
   */
  test('rejects a finite but unsafe magnitude', () => {
    expect(parseCounterAmount(1e308)).toBeNull();
    expect(parseCounterAmount('1e308')).toBeNull();
    expect(parseCounterAmount(-1e308)).toBeNull();
    expect(parseCounterAmount(Number.MAX_SAFE_INTEGER + 10)).toBeNull();
  });

  test('rejects non-numbers and non-finite values', () => {
    expect(parseCounterAmount('banana')).toBeNull();
    expect(parseCounterAmount('')).toBeNull();
    expect(parseCounterAmount(null)).toBeNull();
    expect(parseCounterAmount(Number.NaN)).toBeNull();
    expect(parseCounterAmount(Infinity)).toBeNull();
  });

  test('accepts ordinary whole numbers, signed', () => {
    expect(parseCounterAmount('1')).toBe(1);
    expect(parseCounterAmount('-1')).toBe(-1);
    expect(parseCounterAmount('+5')).toBe(5);
    expect(parseCounterAmount(0)).toBe(0);
  });

  test('rounds a decimal rather than rejecting it', () => {
    expect(parseCounterAmount('2.6')).toBe(3);
  });

  test('accepts the safe-integer boundary itself', () => {
    expect(parseCounterAmount(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe('an unsafe amount never reaches a durable write', () => {
  test('the value is untouched when the amount is out of range', () => {
    // The end-to-end shape of the defect: before the fix this pinned 4 to
    // 9007199254740991 and there was no way to recover the real count.
    const created = counter({ value: 4 });
    const amount = parseCounterAmount('1e308');
    expect(amount).toBeNull();
    expect(findCounterByKey('deaths')!.value).toBe(4);
  });
});
