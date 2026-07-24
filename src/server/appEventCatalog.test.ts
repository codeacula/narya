import { describe, expect, test } from 'bun:test';
import {
  MAX_CATALOG_KEYS,
  MAX_KEY_NAME_LENGTH,
  catalogToDataKeys,
  inferKeyType,
  mergeDataCatalog,
  parseDataCatalog,
} from './appEventCatalog';

describe('inferKeyType', () => {
  test('classifies scalars', () => {
    expect(inferKeyType('x')).toBe('string');
    expect(inferKeyType(3)).toBe('number');
    expect(inferKeyType(true)).toBe('boolean');
  });
  test('classifies a non-scalar as string (it renders as capped JSON)', () => {
    expect(inferKeyType({ a: 1 })).toBe('string');
    expect(inferKeyType([1, 2])).toBe('string');
  });
  test('skips null, undefined, and non-finite numbers', () => {
    expect(inferKeyType(null)).toBeNull();
    expect(inferKeyType(undefined)).toBeNull();
    expect(inferKeyType(Number.POSITIVE_INFINITY)).toBeNull();
    expect(inferKeyType(Number.NaN)).toBeNull();
  });
});

describe('mergeDataCatalog', () => {
  test('adds new keys and reports changed', () => {
    const r = mergeDataCatalog({}, { boss: 'Dragon', wave: 3 });
    expect(r.catalog).toEqual({ boss: 'string', wave: 'number' });
    expect(r.changed).toBe(true);
  });
  test('is a no-op when nothing is new', () => {
    const r = mergeDataCatalog({ boss: 'string' }, { boss: 'Hydra' });
    expect(r.changed).toBe(false);
    expect(r.catalog).toEqual({ boss: 'string' });
  });
  test('last-observed type wins on a conflict', () => {
    const r = mergeDataCatalog({ wave: 'string' }, { wave: 7 });
    expect(r.catalog).toEqual({ wave: 'number' });
    expect(r.changed).toBe(true);
  });
  test('retains keys absent from this payload (cumulative)', () => {
    const r = mergeDataCatalog({ boss: 'string', wave: 'number' }, { boss: 'Hydra' });
    expect(r.catalog).toEqual({ boss: 'string', wave: 'number' });
    expect(r.changed).toBe(false);
  });
  test('skips null/undefined values without marking changed', () => {
    const r = mergeDataCatalog({}, { boss: null, wave: undefined });
    expect(r.catalog).toEqual({});
    expect(r.changed).toBe(false);
  });

  // A key outside the alphabet DATA_CONDITION_FIELD / DATA_CONDITION_FIELD_PATTERN /
  // DATA_TOKEN_PATTERN agree on is unusable in a condition AND in a template. Recording
  // it made the editor offer `data.boss name`, which validateConditions then rejected —
  // disabling Save on the whole trigger over a field the UI itself suggested.
  test('does not record a key outside the condition/template alphabet', () => {
    const r = mergeDataCatalog({}, { 'boss name': 'Dragon', 'wave{2}': 3, 'ok_key.a-1': true });
    expect(r.catalog).toEqual({ 'ok_key.a-1': 'boolean' });
    expect(r.changed).toBe(true);
  });

  test('a payload of only non-conforming keys does not mark changed', () => {
    const r = mergeDataCatalog({}, { 'boss name': 'Dragon', 'wave{2}': 3, 'a b': 1 });
    expect(r.catalog).toEqual({});
    expect(r.changed).toBe(false);
  });

  test('does not record an over-length key name', () => {
    const long = 'k'.repeat(MAX_KEY_NAME_LENGTH + 1);
    const atLimit = 'a'.repeat(MAX_KEY_NAME_LENGTH);
    const r = mergeDataCatalog({}, { [long]: 'x', [atLimit]: 'y' });
    expect(r.catalog).toEqual({ [atLimit]: 'string' });
    expect(r.changed).toBe(true);
  });

  test('a full catalog ignores a new key but still records an existing key type change', () => {
    const stored: Record<string, 'string' | 'number' | 'boolean'> = {};
    for (let i = 0; i < MAX_CATALOG_KEYS; i += 1) stored[`k${i}`] = 'string';

    const ignored = mergeDataCatalog(stored, { fresh: 'x' });
    expect(ignored.changed).toBe(false);
    expect(ignored.catalog.fresh).toBeUndefined();
    expect(Object.keys(ignored.catalog)).toHaveLength(MAX_CATALOG_KEYS);

    const updated = mergeDataCatalog(stored, { k0: 7, fresh: 'x' });
    expect(updated.changed).toBe(true);
    expect(updated.catalog.k0).toBe('number');
    expect(updated.catalog.fresh).toBeUndefined();
    expect(Object.keys(updated.catalog)).toHaveLength(MAX_CATALOG_KEYS);
  });

  test('an existing key over the caps is never evicted, only left alone', () => {
    const long = 'k'.repeat(MAX_KEY_NAME_LENGTH + 1);
    const stored = { 'boss name': 'string', [long]: 'number' } as Record<string, 'string' | 'number' | 'boolean'>;
    const r = mergeDataCatalog(stored, { wave: 1 });
    expect(r.catalog).toEqual({ 'boss name': 'string', [long]: 'number', wave: 'number' });
    expect(r.changed).toBe(true);
  });

  // `__proto__` slips past both caps: it never occupies a catalog slot, and assigning it
  // is a no-op, so before the guard it reported changed=true on every single payload —
  // one row rewrite per inbound event, forever, from an attacker-influenced key name.
  test('a __proto__ key is never recorded and never forces a repeat write', () => {
    const data = JSON.parse('{"__proto__":"x","wave":1}') as Record<string, unknown>;
    const first = mergeDataCatalog({}, data);
    expect(first.changed).toBe(true);
    expect(Object.keys(first.catalog)).toEqual(['wave']);
    const second = mergeDataCatalog(first.catalog, data);
    expect(second.changed).toBe(false);
  });

  // The growth this cap exists for: keys embedding an id/timestamp made `changed` true
  // for EVERY entry forever — a parse + stringify + row rewrite of an ever-growing blob
  // on the consumer thread, and an editor picker listing every key ever seen.
  test('a rotating-key app stops growing the catalog and stops forcing writes', () => {
    let catalog: Record<string, 'string' | 'number' | 'boolean'> = {};
    let writes = 0;
    for (let i = 0; i < 500; i += 1) {
      const r = mergeDataCatalog(catalog, { [`run_${i}_score`]: i });
      catalog = r.catalog;
      if (r.changed) writes += 1;
    }
    expect(Object.keys(catalog)).toHaveLength(MAX_CATALOG_KEYS);
    expect(writes).toBe(MAX_CATALOG_KEYS);
  });
});

describe('parseDataCatalog', () => {
  test('parses a catalog and drops invalid entries', () => {
    expect(parseDataCatalog('{"boss":"string","bad":"weird","n":5}')).toEqual({ boss: 'string' });
  });
  test('malformed or non-object JSON reads as empty', () => {
    expect(parseDataCatalog('not json')).toEqual({});
    expect(parseDataCatalog('[]')).toEqual({});
    expect(parseDataCatalog('{}')).toEqual({});
  });
});

describe('catalogToDataKeys', () => {
  test('returns name-sorted keys', () => {
    expect(catalogToDataKeys({ wave: 'number', boss: 'string' })).toEqual([
      { name: 'boss', type: 'string' },
      { name: 'wave', type: 'number' },
    ]);
  });
});
