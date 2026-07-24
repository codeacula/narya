import { describe, expect, test } from 'bun:test';
import { processInboundEntry, type InboundEntryContext } from './redisInbound';

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
