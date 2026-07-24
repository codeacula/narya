import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createAction } from './actions';
import { db } from './db';
import {
  appExistsById,
  countTriggersForEvent,
  createApp,
  declareAppEvent,
  findAppByTokenHash,
  hashAppToken,
  isDeclaredEvent,
  isKnownSource,
  listApps,
  listAppEvents,
  listSelectableSources,
  mintAppToken,
  recordDataKeys,
  removeAppEvent,
  revokeAppToken,
  setAppDisabled,
} from './apps';
import { HttpRouteError } from './http';
import { setRewardSource } from './rewardProvenance';

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

describe('app event data catalog', () => {
  beforeEach(() => {
    db.prepare('delete from automation_triggers').run();
    db.prepare('delete from actions').run();
    db.prepare('delete from app_events').run();
    db.prepare('delete from apps').run();
  });

  // Belt-and-suspenders alongside beforeEach's own cleanup: beforeEach only runs
  // before the NEXT test, so whatever the LAST test in this block inserts directly
  // into automation_triggers (countTriggersForEvent's own tests, and
  // boundTriggerCount's below) would otherwise survive past this file and make
  // rowToTrigger log "unreadable conditions JSON" noise in whichever suite runs
  // next in the same process (see the apps.test.ts hygiene note in the Phase C2
  // brief).
  afterEach(() => {
    db.prepare('delete from automation_triggers').run();
    db.prepare('delete from actions').run();
  });

  test('a freshly declared event has an empty dataKeys catalog and boundTriggerCount 0', () => {
    const app = createApp('catalogapp');
    const event = declareAppEvent(app.id, 'boss_killed');
    expect(event.dataKeys).toEqual([]);
    expect(event.boundTriggerCount).toBe(0);
    expect((event as unknown as Record<string, unknown>)['dataSchemaJson']).toBeUndefined();
  });

  test('recordDataKeys learns keys and is a no-op once converged', () => {
    // total_changes() is a monotonic, per-connection counter of rows written by any
    // INSERT/UPDATE/DELETE since the connection opened; a SELECT never bumps it. It
    // proves the no-op branch performs literally zero writes, independent of the
    // return value (a content-identical UPDATE would read back the same JSON, so
    // comparing the stored string before/after would not catch a spurious write).
    const totalChanges = () => (db.query('select total_changes() as c').get() as { c: number }).c;

    const app = createApp('learnapp');
    declareAppEvent(app.id, 'boss_killed');

    expect(recordDataKeys(app.id, 'boss_killed', { boss: 'Dragon', wave: 3 })).toBe(true);
    expect(listAppEvents(app.id)[0]!.dataKeys).toEqual([
      { name: 'boss', type: 'string' },
      { name: 'wave', type: 'number' },
    ]);

    // Same shape again -> no write at all (not just a same-value write).
    const beforeNoOp = totalChanges();
    expect(recordDataKeys(app.id, 'boss_killed', { boss: 'Hydra', wave: 9 })).toBe(false);
    expect(totalChanges()).toBe(beforeNoOp);

    // A new key -> a real write (the counter advances), and the old keys are retained.
    const beforeRealWrite = totalChanges();
    expect(recordDataKeys(app.id, 'boss_killed', { loot: true })).toBe(true);
    expect(totalChanges()).toBe(beforeRealWrite + 1);
    expect(listAppEvents(app.id)[0]!.dataKeys.map(k => k.name)).toEqual(['boss', 'loot', 'wave']);
  });

  test('recordDataKeys on an undeclared event writes nothing', () => {
    const totalChanges = () => (db.query('select total_changes() as c').get() as { c: number }).c;
    const app = createApp('nodeclapp');
    const before = totalChanges();
    expect(recordDataKeys(app.id, 'never_declared', { a: 1 })).toBe(false);
    expect(totalChanges()).toBe(before);
  });

  test('countTriggersForEvent counts only redis_event triggers bound to that (app, event)', () => {
    const app = createApp('countapp');
    declareAppEvent(app.id, 'boss_killed');
    declareAppEvent(app.id, 'other_event');
    expect(countTriggersForEvent(app.id, 'boss_killed')).toBe(0);

    const someActionId = createAction({
      name: 'Catalog test action',
      description: '',
      enabled: true,
      steps: [{ type: 'obs_transition', enabled: true, delayMs: 0, payload: {} }],
    }).id;

    // Insert a redis_event trigger bound to (app, boss_killed) directly via the DB,
    // so this suite does not import automationTriggers.ts (that module imports THIS
    // one — see the cycle note in apps.ts).
    const now = new Date().toISOString();
    db.prepare(
      `insert into automation_triggers (id, kind, action_id, module_id, enabled, config_json,
         global_cooldown_ms, user_cooldown_ms, created_at, updated_at)
       values (?, 'redis_event', ?, null, 1, ?, 0, 0, ?, ?)`,
    ).run(crypto.randomUUID(), someActionId, JSON.stringify({ appId: app.id, eventName: 'boss_killed' }), now, now);

    // A redis_event trigger with unreadable config_json must be skipped, not thrown on.
    db.prepare(
      `insert into automation_triggers (id, kind, action_id, module_id, enabled, config_json,
         global_cooldown_ms, user_cooldown_ms, created_at, updated_at)
       values (?, 'redis_event', ?, null, 1, ?, 0, 0, ?, ?)`,
    ).run(crypto.randomUUID(), someActionId, 'not valid json{{{', now, now);

    expect(() => countTriggersForEvent(app.id, 'boss_killed')).not.toThrow();
    expect(countTriggersForEvent(app.id, 'boss_killed')).toBe(1);
    expect(countTriggersForEvent(app.id, 'other_event')).toBe(0);
    expect(countTriggersForEvent('someone-else', 'boss_killed')).toBe(0);
  });

  test('listAppEvents reports each event\'s bound-trigger count (Task 7 wire-up)', () => {
    const app = createApp('wiredapp');
    declareAppEvent(app.id, 'boss_killed');
    declareAppEvent(app.id, 'unbound_event');

    // Before anything is bound, both declared events report 0.
    const before = listAppEvents(app.id);
    expect(before.find(e => e.eventName === 'boss_killed')?.boundTriggerCount).toBe(0);
    expect(before.find(e => e.eventName === 'unbound_event')?.boundTriggerCount).toBe(0);

    const someActionId = createAction({
      name: 'Bound-count test action',
      description: '',
      enabled: true,
      steps: [{ type: 'obs_transition', enabled: true, delayMs: 0, payload: {} }],
    }).id;

    // Bind a redis_event trigger directly via the DB — same rationale as
    // countTriggersForEvent's test above: this suite must not import
    // automationTriggers.ts, which already imports apps.ts.
    const now = new Date().toISOString();
    db.prepare(
      `insert into automation_triggers (id, kind, action_id, module_id, enabled, config_json,
         global_cooldown_ms, user_cooldown_ms, created_at, updated_at)
       values (?, 'redis_event', ?, null, 1, ?, 0, 0, ?, ?)`,
    ).run(crypto.randomUUID(), someActionId, JSON.stringify({ appId: app.id, eventName: 'boss_killed' }), now, now);

    const after = listAppEvents(app.id);
    expect(after.find(e => e.eventName === 'boss_killed')?.boundTriggerCount).toBe(1);
    expect(after.find(e => e.eventName === 'unbound_event')?.boundTriggerCount).toBe(0);

    // declareAppEvent returns the same shape as listAppEvents — a freshly declared
    // event on this same app still reports 0, even though the app now has a bound
    // trigger on a DIFFERENT event.
    const freshEvent = declareAppEvent(app.id, 'freshly_declared');
    expect(freshEvent.boundTriggerCount).toBe(0);
  });
});

describe('app API tokens', () => {
  beforeEach(() => { db.prepare('delete from apps').run(); });

  test('an app starts with no token and reports tokenConfigured false', () => {
    const app = createApp('tokenapp');
    expect(app.tokenConfigured).toBe(false);
    expect((app as unknown as Record<string, unknown>)['tokenHash']).toBeUndefined();
  });

  test('minting returns a plaintext token once and only stores its hash', () => {
    const app = createApp('mintapp');
    const token = mintAppToken(app.id);
    expect(token).toMatch(/^narya_app_[0-9a-f]{64}$/);
    // The plaintext is never recoverable from the registry.
    const listed = listApps().find(a => a.id === app.id)!;
    expect(listed.tokenConfigured).toBe(true);
    expect(JSON.stringify(listed)).not.toContain(token);
    // The stored value is the hash, not the token.
    expect(findAppByTokenHash(hashAppToken(token))?.id).toBe(app.id);
    expect(findAppByTokenHash(token)).toBeNull();
  });

  test('re-minting rotates: the previous token stops resolving', () => {
    const app = createApp('rotateapp');
    const first = mintAppToken(app.id);
    const second = mintAppToken(app.id);
    expect(second).not.toBe(first);
    expect(findAppByTokenHash(hashAppToken(first))).toBeNull();
    expect(findAppByTokenHash(hashAppToken(second))?.id).toBe(app.id);
  });

  test('revoking clears the token', () => {
    const app = createApp('revokeapp');
    const token = mintAppToken(app.id);
    revokeAppToken(app.id);
    expect(findAppByTokenHash(hashAppToken(token))).toBeNull();
    expect(listApps().find(a => a.id === app.id)!.tokenConfigured).toBe(false);
  });

  // An update against a non-existent id is a silent no-op in SQLite, so without this
  // check a typo'd app id reads back to the operator as a successful revoke — they
  // believe a credential is dead while it is still live. Mint already 404s; revoke,
  // the one that matters for security, must not be the lenient half of the pair.
  test('revoking an unknown app id is a 404, not a silent success', () => {
    expect(() => revokeAppToken('no-such-app-id')).toThrow(HttpRouteError);
    try {
      revokeAppToken('no-such-app-id');
      throw new Error('expected revokeAppToken to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpRouteError);
      expect((error as HttpRouteError).status).toBe(404);
    }
    // …and mint, the route it now matches, still behaves the same way.
    expect(() => mintAppToken('no-such-app-id')).toThrow(HttpRouteError);
  });
});

describe('app reward counts (Task 7 wire-up)', () => {
  beforeEach(() => {
    db.prepare('delete from reward_provenance').run();
    db.prepare('delete from apps').run();
  });

  test('listApps reports each app\'s reward count, keyed by name and unaffected by other sources', () => {
    const appA = createApp('countsapp');
    const appB = createApp('othercountsapp');

    // A freshly registered app with no provenance rows at all reports 0.
    expect(listApps().find(a => a.id === appA.id)?.rewardCount).toBe(0);
    expect(listApps().find(a => a.id === appB.id)?.rewardCount).toBe(0);

    // Provenance rows attributed to appA's NAME (reward_provenance.source) count
    // toward appA only.
    setRewardSource('r1', appA.name);
    setRewardSource('r2', appA.name);
    // A different app's rewards, and the reserved 'manual'/'narya' sentinels, must
    // never leak into appA's count.
    setRewardSource('r3', appB.name);
    setRewardSource('r4', 'manual');
    setRewardSource('r5', 'narya');

    const apps = listApps();
    expect(apps.find(a => a.id === appA.id)?.rewardCount).toBe(2);
    expect(apps.find(a => a.id === appB.id)?.rewardCount).toBe(1);
  });
});

describe('reward_provenance idempotency index', () => {
  beforeEach(() => { db.prepare('delete from reward_provenance').run(); });

  // Task 3 will formalize a provenance writer that carries external_ref; until then
  // this proves the index directly against the table, per the Phase D brief.
  function setRewardSourceWithRef(rewardId: string, source: string, externalRef: string) {
    db.prepare('insert into reward_provenance (reward_id, source, external_ref, created_at) values (?, ?, ?, ?)')
      .run(rewardId, source, externalRef, new Date().toISOString());
  }

  test('the partial unique index rejects a duplicate (source, external_ref) but allows many nulls', () => {
    // Two null external_refs for the same source are fine (Phase A rows look like this).
    setRewardSource('r1', 'narya');
    setRewardSource('r2', 'narya');
    // A duplicate (source, external_ref) is rejected.
    setRewardSourceWithRef('r3', 'appx', 'ext-1');
    expect(() => setRewardSourceWithRef('r4', 'appx', 'ext-1')).toThrow();
    // The same external_ref under a DIFFERENT source is independent.
    expect(() => setRewardSourceWithRef('r5', 'appy', 'ext-1')).not.toThrow();
  });
});
