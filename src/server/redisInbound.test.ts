import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createApp, declareAppEvent, listAppEvents, recordDataKeys as realRecordDataKeys } from './apps';
import { initAutomation } from './automation';
import { db } from './db';
import type { RedisClientLike } from './redis';
import {
  __setRecordDataKeysForTest,
  handleEntry,
  processInboundEntry,
  type InboundEntryContext,
} from './redisInbound';
import { RuntimeState } from './runtime';

// These tests exercise the PURE decision core only — no live Redis, no DB. The
// declaration check is injected as a predicate (`isDeclared`), so the core never
// imports apps.ts: the same function the live loop feeds `isDeclaredEvent` with.
//
// The live XREADGROUP / XACK / XAUTOCLAIM / XGROUP wiring is covered by an opt-in
// integration smoke (see redisInboundSmoke.test.ts), NOT this in-memory suite.

function ctx(overrides: Partial<InboundEntryContext> = {}): InboundEntryContext {
  return {
    appId: 'app-a',
    isDeclared: () => true,
    streamEntryId: '1700000000000-0',
    ...overrides,
  };
}

function envelope(fields: Record<string, unknown>): string {
  return JSON.stringify(fields);
}

describe('processInboundEntry (decision core)', () => {
  test('drops a non-JSON raw value', () => {
    expect(processInboundEntry('not json {', ctx())).toEqual({ drop: true });
  });

  test('drops a non-string raw value', () => {
    expect(processInboundEntry(undefined, ctx())).toEqual({ drop: true });
    expect(processInboundEntry(42, ctx())).toEqual({ drop: true });
  });

  test('drops a JSON value that is not an object', () => {
    expect(processInboundEntry('"a string"', ctx())).toEqual({ drop: true });
    expect(processInboundEntry('[1,2,3]', ctx())).toEqual({ drop: true });
    expect(processInboundEntry('null', ctx())).toEqual({ drop: true });
  });

  test('drops an entry whose serialized data exceeds the size cap', () => {
    const huge = { blob: 'x'.repeat(17 * 1024) }; // > 16 KB serialized
    const decision = processInboundEntry(envelope({ type: 'ping', data: huge }), ctx());
    expect(decision).toEqual({ drop: true });
  });

  test('drops an entry whose data has more fields than the field cap', () => {
    const many: Record<string, unknown> = {};
    for (let i = 0; i < 200; i += 1) many[`k${i}`] = i;
    const decision = processInboundEntry(envelope({ type: 'ping', data: many }), ctx());
    expect(decision).toEqual({ drop: true });
  });

  test('drops an entry whose type is not declared', () => {
    const decision = processInboundEntry(
      envelope({ type: 'undeclared', data: {} }),
      ctx({ isDeclared: () => false }),
    );
    expect(decision).toEqual({ drop: true });
  });

  test('drops an entry with a missing or blank type', () => {
    expect(processInboundEntry(envelope({ data: {} }), ctx())).toEqual({ drop: true });
    expect(processInboundEntry(envelope({ type: '', data: {} }), ctx())).toEqual({ drop: true });
    expect(processInboundEntry(envelope({ type: '   ', data: {} }), ctx())).toEqual({ drop: true });
    expect(processInboundEntry(envelope({ type: 123, data: {} }), ctx())).toEqual({ drop: true });
  });

  test('dispatches a valid declared entry with the app-supplied dedup id', () => {
    const decision = processInboundEntry(
      envelope({ type: 'donation', id: 'evt-1', data: { amount: 5, from: 'nova' } }),
      ctx({ appId: 'app-a', streamEntryId: '1700000000000-0' }),
    );
    expect('dispatch' in decision).toBe(true);
    if (!('dispatch' in decision)) throw new Error('expected dispatch');
    expect(decision.dispatch).toEqual({
      appId: 'app-a',
      eventName: 'donation',
      eventId: 'app-a:evt-1',
      data: { amount: 5, from: 'nova' },
    });
  });

  test('trims a padded type and uses the trimmed name for eventName', () => {
    const decision = processInboundEntry(
      envelope({ type: '  donation  ', id: 'evt-9', data: {} }),
      ctx({ appId: 'app-a' }),
    );
    if (!('dispatch' in decision)) throw new Error('expected dispatch');
    expect(decision.dispatch.eventName).toBe('donation');
  });

  test('falls back to the stream entry id when envelope.id is absent', () => {
    const decision = processInboundEntry(
      envelope({ type: 'ping', data: {} }),
      ctx({ appId: 'app-a', streamEntryId: '42-7' }),
    );
    if (!('dispatch' in decision)) throw new Error('expected dispatch');
    expect(decision.dispatch.eventId).toBe('app-a:42-7');
  });

  test('falls back to the stream entry id when envelope.id is a blank string', () => {
    const decision = processInboundEntry(
      envelope({ type: 'ping', id: '   ', data: {} }),
      ctx({ appId: 'app-a', streamEntryId: '99-0' }),
    );
    if (!('dispatch' in decision)) throw new Error('expected dispatch');
    expect(decision.dispatch.eventId).toBe('app-a:99-0');
  });

  test('coerces a non-object data to an empty object', () => {
    const decision = processInboundEntry(
      envelope({ type: 'ping', id: 'e', data: 'not an object' }),
      ctx(),
    );
    if (!('dispatch' in decision)) throw new Error('expected dispatch');
    expect(decision.dispatch.data).toEqual({});
  });

  test('defaults missing data to an empty object', () => {
    const decision = processInboundEntry(envelope({ type: 'ping', id: 'e' }), ctx());
    if (!('dispatch' in decision)) throw new Error('expected dispatch');
    expect(decision.dispatch.data).toEqual({});
  });

  test('lifts reserved actor/login string keys from data without deleting them', () => {
    const decision = processInboundEntry(
      envelope({ type: 'boss', id: 'e', data: { actor: 'Ada', login: 'ada', boss: 'Dragon' } }),
      ctx({ appId: 'app-a' }),
    );
    if (!('dispatch' in decision)) throw new Error('expected dispatch');
    expect(decision.dispatch.actor).toBe('Ada');
    expect(decision.dispatch.login).toBe('ada');
    // Reserved keys are lifted, NOT moved: {actor} and {data.actor} render the same value.
    expect(decision.dispatch.data).toEqual({ actor: 'Ada', login: 'ada', boss: 'Dragon' });
  });

  test('a non-string reserved key leaves the field absent but still dispatches', () => {
    const decision = processInboundEntry(
      envelope({ type: 'boss', id: 'e', data: { actor: 42, boss: 'Dragon' } }),
      ctx({ appId: 'app-a' }),
    );
    if (!('dispatch' in decision)) throw new Error('expected dispatch');
    expect('actor' in decision.dispatch).toBe(false);
    expect('login' in decision.dispatch).toBe(false);
    expect(decision.dispatch.data).toEqual({ actor: 42, boss: 'Dragon' });
  });

  test('an entry with no reserved keys leaves actor/login absent', () => {
    const decision = processInboundEntry(
      envelope({ type: 'ping', id: 'e', data: { boss: 'Dragon' } }),
      ctx({ appId: 'app-a' }),
    );
    if (!('dispatch' in decision)) throw new Error('expected dispatch');
    expect('actor' in decision.dispatch).toBe(false);
    expect('login' in decision.dispatch).toBe(false);
  });

  // The load-bearing property: eventId is namespaced by appId, so two DIFFERENT apps
  // that each supply the SAME id can never collide on the per-trigger dedup key.
  // Cross-app suppression is therefore structurally impossible.
  test('two apps with an identical envelope.id yield different eventIds', () => {
    const raw = envelope({ type: 'ping', id: 'shared-id', data: {} });
    const a = processInboundEntry(raw, ctx({ appId: 'app-a' }));
    const b = processInboundEntry(raw, ctx({ appId: 'app-b' }));
    if (!('dispatch' in a) || !('dispatch' in b)) throw new Error('expected dispatch');
    expect(a.dispatch.eventId).toBe('app-a:shared-id');
    expect(b.dispatch.eventId).toBe('app-b:shared-id');
    expect(a.dispatch.eventId).not.toBe(b.dispatch.eventId);
  });
});

// `handleEntry` exercises the live loop's per-entry wiring: decide -> dispatch ->
// XACK -> learn. A hand-rolled fake client (matching the eventBus.test.ts pattern)
// tracks xack calls by count, which is the load-bearing assertion below — NOT
// mock.module, which this codebase has already found unreliable for re-linking a
// module another test file loaded first (see eventBus.test.ts's own note, and
// redisInboundSmoke.test.ts statically imports this module regardless of its
// describe.skip).
function fakeClient(): RedisClientLike & { xackCalls: unknown[][] } {
  const xackCalls: unknown[][] = [];
  return {
    on() {},
    xadd: async () => null,
    xreadgroup: async () => null,
    xack: async (...args: unknown[]) => { xackCalls.push(args); return 1; },
    xautoclaim: async () => null,
    xgroup: async () => null,
    quit: async () => undefined,
    disconnect() {},
    xackCalls,
  };
}

function entryFields(payload: Record<string, unknown>): unknown[] {
  return ['v', JSON.stringify(payload)];
}

describe('handleEntry (live loop: decide -> dispatch -> XACK -> learn)', () => {
  beforeEach(() => {
    // handleEntry's dispatch branch runs the REAL trigger dispatcher, which scans the
    // whole automation_triggers table for kind='redis_event' — clear it so a leftover
    // row from another *.test.ts file (e.g. apps.test.ts's deliberately-unparseable
    // fixture) cannot leak noise or, worse, a spurious match into these tests.
    db.prepare('delete from automation_triggers').run();
    db.prepare('delete from app_events').run();
    db.prepare('delete from apps').run();
    initAutomation(new RuntimeState());
  });

  afterEach(() => {
    // Guard against leaking an injected throw into a later test/file.
    __setRecordDataKeysForTest(realRecordDataKeys);
  });

  test('a declared entry that dispatches records its data keys', async () => {
    const app = createApp('catalog-learn-app');
    declareAppEvent(app.id, 'donation');
    const client = fakeClient();

    await handleEntry(client, app.id, 'stream-key', '1-1', entryFields({
      type: 'donation',
      id: 'evt-1',
      data: { amount: 5, from: 'nova' },
    }));

    expect(client.xackCalls).toHaveLength(1);
    const events = listAppEvents(app.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.dataKeys).toEqual([
      { name: 'amount', type: 'number' },
      { name: 'from', type: 'string' },
    ]);
  });

  test('a dropped entry (undeclared type) records nothing', async () => {
    const app = createApp('catalog-drop-app');
    // A DIFFERENT event is declared so the catalog is observable and provably
    // untouched — this isolates the `if ('dispatch' in decision)` guard in
    // handleEntry from recordDataKeys' own (already-tested) undeclared no-op.
    declareAppEvent(app.id, 'boss_killed');
    const client = fakeClient();

    await handleEntry(client, app.id, 'stream-key', '1-1', entryFields({
      type: 'ghost_event',
      id: 'evt-1',
      data: { amount: 5 },
    }));

    // The entry is still XACKed even though it was dropped, undisturbed.
    expect(client.xackCalls).toHaveLength(1);
    const events = listAppEvents(app.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.dataKeys).toEqual([]);
  });

  test('a learn that throws does not stall the loop and does not double-XACK', async () => {
    const app = createApp('catalog-throw-app');
    declareAppEvent(app.id, 'donation');
    __setRecordDataKeysForTest(() => { throw new Error('boom'); });
    const client = fakeClient();

    // The catalog throw is expected and caught here — it logs via logInboundError,
    // so capture console.error rather than letting it print during the run.
    const errors: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };
    try {
      // If the inner try/catch around the learn call were removed, this throw would
      // propagate to handleEntry's OUTER catch, which XACKs a SECOND time — so
      // xackCalls landing at exactly 1 (not 2) is what proves the isolation, not
      // merely that the call resolved.
      await expect(
        handleEntry(client, app.id, 'stream-key', '1-1', entryFields({
          type: 'donation',
          id: 'evt-1',
          data: { amount: 5 },
        })),
      ).resolves.toBeUndefined();
    } finally {
      console.error = originalError;
    }

    expect(client.xackCalls).toHaveLength(1);
    // The dispatch itself was unaffected by the learn throwing — the entry's data
    // was never recorded, but nothing here should have crashed the trigger run.
    expect(listAppEvents(app.id)[0]!.dataKeys).toEqual([]);
    // Logged through the inner catch's own context tag, not the outer 'entry' one.
    expect(errors.some(a => String(a[0]).includes('catalog') && String(a[1]).includes('boom'))).toBe(true);
  });
});
