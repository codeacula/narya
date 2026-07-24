import { describe, expect, test } from 'bun:test';
import { catalogToDataKeys, inferKeyType, mergeDataCatalog, parseDataCatalog } from './appEventCatalog';

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
