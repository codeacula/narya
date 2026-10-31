import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { saveAppConfig } from './appConfig';
import { __resetRedisForTest, __setRedisClientFactory, startRedis } from './redis';
import { publishModuleSwitch, publishRedeem, publishTwitchEvent } from './eventBus';

// Drive the REAL redisPublish through the client seam rather than mock.module('./redis').
// mock.module is global and does NOT reliably re-link an eventBus that an earlier test
// file already imported, so the old mock-based test only passed in isolation and failed
// under full-suite ordering. A fake client captures the xadd args order-independently.
const xaddCalls: unknown[][] = [];
let xaddBehavior: 'ok' | 'reject' = 'ok';

function fakeClient() {
  const handlers: Record<string, (arg?: unknown) => void> = {};
  return {
    on(event: string, cb: (arg?: unknown) => void) { handlers[event] = cb; },
    async xadd(...args: unknown[]) {
      if (xaddBehavior === 'reject') throw new Error('down');
      xaddCalls.push(args);
      return '1-0';
    },
    quit: async () => {},
    disconnect() {},
    emit(event: string, arg?: unknown) { handlers[event]?.(arg); },
  };
}

// xadd args are [key, 'MINID', '~', minId, '*', 'v', value].
function lastKey(): string { return String(xaddCalls.at(-1)?.[0]); }
function lastEnvelope() { return JSON.parse(String(xaddCalls.at(-1)?.[6])); }

describe('event bus', () => {
  let client: ReturnType<typeof fakeClient>;
  beforeEach(() => {
    xaddCalls.length = 0;
    xaddBehavior = 'ok';
    __resetRedisForTest();
    client = fakeClient();
    __setRedisClientFactory(() => client as never);
    saveAppConfig({ redisUrl: 'redis://127.0.0.1:6379' });
    startRedis();
    client.emit('ready');
  });
  afterEach(() => { __resetRedisForTest(); saveAppConfig({ clearRedisUrl: true }); });

  test('no redisUrl -> publish is a no-op (nothing sent)', async () => {
    saveAppConfig({ clearRedisUrl: true });
    publishRedeem({ sourceId: 'm1', channel: { id: 'b1', login: 'streamer' }, rewardId: 'r1', rewardTitle: 'Hydrate', rewardSource: 'pztmi', rewardExternalRef: null, redemptionId: 'x1', userId: 'u1', userLogin: 'viewer', userInput: 'go' });
    await Promise.resolve();
    expect(xaddCalls).toHaveLength(0);
  });

  test('publishes to an env-prefixed stream key', async () => {
    // STREAM_PREFIX is resolved once at eventBus load time from the environment. Under
    // `bun test`, NODE_ENV=test, so with no explicit STREAMER_TOOLS_REDIS_PREFIX the key
    // must be namespaced to `test` — the mechanism that keeps dev/prod off each other's
    // stream when they share a redisUrl.
    publishRedeem({ sourceId: 'k1', channel: { id: 'b1', login: 'streamer' }, rewardId: 'r1', rewardTitle: 'Hydrate', rewardSource: 'pztmi', rewardExternalRef: null, redemptionId: 'x1', userId: 'u1', userLogin: 'viewer', userInput: 'go' });
    await Promise.resolve();
    expect(lastKey()).toBe('narya:test:events');
  });

  test('builds a v1 envelope with a deterministic id and only allowlisted data keys', async () => {
    publishRedeem({ sourceId: 'm1', channel: { id: 'b1', login: 'streamer' }, rewardId: 'r1', rewardTitle: 'Hydrate', rewardSource: 'pztmi', rewardExternalRef: null, redemptionId: 'x1', userId: 'u1', userLogin: 'viewer', userInput: 'go' });
    await Promise.resolve();
    const env = lastEnvelope();
    expect(env.version).toBe(1);
    expect(env.type).toBe('redeem');
    expect(env.id).toBe('m1');                       // derived from source id
    expect(env.channel).toEqual({ id: 'b1', login: 'streamer' });
    expect(Object.keys(env.data).sort()).toEqual(
      ['redemptionId', 'rewardExternalRef', 'rewardId', 'rewardSource', 'rewardTitle', 'userId', 'userInput', 'userLogin'].sort(),
    );
    expect(env.data.rewardSource).toBe('pztmi');
  });

  // The egress boundary is per-publisher: each shape may only carry its own allowlisted
  // keys, so a future field addition can't silently leak onto the stream.
  test('publishTwitchEvent emits exactly its allowlisted data keys', async () => {
    publishTwitchEvent({ sourceId: 't1', channel: { id: 'b1', login: 'streamer' }, eventKind: 'subscribe', actorUserId: 'u1', actorLogin: 'viewer', amount: 5, tier: '1000' });
    await Promise.resolve();
    const env = lastEnvelope();
    expect(env.type).toBe('twitch_event');
    expect(Object.keys(env.data).sort()).toEqual(['actorLogin', 'actorUserId', 'amount', 'eventKind', 'tier'].sort());
  });

  test('publishModuleSwitch emits exactly its allowlisted data keys', async () => {
    publishModuleSwitch({ channel: { id: 'b1', login: 'streamer' }, fromModuleId: 'a', toModuleId: 'b', categoryId: 'c', categoryName: 'Just Chatting' });
    await Promise.resolve();
    const env = lastEnvelope();
    expect(env.type).toBe('module_switch');
    expect(Object.keys(env.data).sort()).toEqual(['categoryId', 'categoryName', 'fromModuleId', 'toModuleId'].sort());
  });

  test('a rejecting redisPublish is swallowed AND logged, never escaping publishRedeem', async () => {
    xaddBehavior = 'reject';
    const errors: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };
    try {
      expect(() => publishRedeem({ sourceId: 'm2', channel: { id: 'b1', login: 's' }, rewardId: 'r', rewardTitle: 't', rewardSource: null, rewardExternalRef: null, redemptionId: 'x', userId: 'u', userLogin: 'v', userInput: '' })).not.toThrow();
      // Fire-and-forget: let the rejected promise settle so the .catch actually runs.
      await Promise.resolve();
      await Promise.resolve();
    } finally {
      console.error = originalError;
    }
    // A removed `.catch(...)` would leave an unhandled rejection and no log — this
    // assertion is what proves the swallow, which the old sync-only check did not.
    expect(errors.some(a => String(a[0]).includes('Redis publish failed'))).toBe(true);
  });
});
