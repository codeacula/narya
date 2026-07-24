import { beforeEach, describe, expect, test } from 'bun:test';
import { db } from './db';
import {
  appExistsById,
  createApp,
  declareAppEvent,
  isDeclaredEvent,
  isKnownSource,
  listApps,
  listAppEvents,
  listSelectableSources,
  removeAppEvent,
  setAppDisabled,
} from './apps';

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

describe('app events', () => {
  beforeEach(() => { db.prepare('delete from app_events').run(); db.prepare('delete from apps').run(); });
  test('declare / list / isDeclared / remove', () => {
    const app = createApp('pztmi');
    expect(appExistsById(app.id)).toBe(true);
    declareAppEvent(app.id, 'boss_killed');
    declareAppEvent(app.id, 'boss_killed'); // idempotent
    expect(listAppEvents(app.id).map(e => e.eventName)).toEqual(['boss_killed']);
    expect(isDeclaredEvent(app.id, 'boss_killed')).toBe(true);
    expect(isDeclaredEvent(app.id, 'undeclared')).toBe(false);
    removeAppEvent(app.id, 'boss_killed');
    expect(isDeclaredEvent(app.id, 'boss_killed')).toBe(false);
  });
  test('an invalid event name is rejected', () => {
    const app = createApp('pztmi');
    expect(() => declareAppEvent(app.id, 'Bad Name!')).toThrow();
  });
  test('deleting an app cascades its events', () => {
    const app = createApp('pztmi');
    declareAppEvent(app.id, 'boss_killed');
    db.prepare('delete from apps where id = ?').run(app.id);
    expect(listAppEvents(app.id)).toEqual([]);
  });
});
