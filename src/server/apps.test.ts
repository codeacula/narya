import { beforeEach, describe, expect, test } from 'bun:test';
import { db } from './db';
import { createApp, isKnownSource, listApps, listSelectableSources, setAppDisabled } from './apps';

describe('apps registry', () => {
  beforeEach(() => { db.prepare('delete from apps').run(); });

  test('create + list', () => {
    const app = createApp('pztmi');
    expect(app.name).toBe('pztmi');
    expect(app.disabledAt).toBeNull();
    expect(listApps().map(a => a.name)).toEqual(['pztmi']);
  });

  test('duplicate name is rejected', () => {
    createApp('pztmi');
    expect(() => createApp('pztmi')).toThrow();
  });

  test('sentinels and registered apps are known sources; unknown is not', () => {
    createApp('pztmi');
    expect(isKnownSource('narya')).toBe(true);
    expect(isKnownSource('manual')).toBe(true);
    expect(isKnownSource('pztmi')).toBe(true);
    expect(isKnownSource('ghost')).toBe(false);
  });

  test('a disabled app stays a known source but drops out of selectable sources', () => {
    const app = createApp('pztmi');
    setAppDisabled(app.id, true);
    expect(isKnownSource('pztmi')).toBe(true);       // provenance rows stay valid
    expect(listSelectableSources()).toEqual(['narya', 'manual']);
  });
});
