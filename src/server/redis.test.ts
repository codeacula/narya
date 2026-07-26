import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { saveAppConfig } from './appConfig';
import { __resetRedisForTest, __setRedisClientFactory, getRedisStatus, inboundKey, isRedisConnected, redisPublish, startRedis, stopRedis, streamPrefix } from './redis';

type Handlers = Record<string, (arg?: unknown) => void>;
function fakeClient() {
  const handlers: Handlers = {};
  const xaddCalls: unknown[][] = [];
  return {
    handlers, xaddCalls, quit: async () => {}, disconnect() {},
    on(event: string, cb: (arg?: unknown) => void) { handlers[event] = cb; },
    async xadd(...args: unknown[]) { xaddCalls.push(args); return '1-0'; },
    emit(event: string, arg?: unknown) { handlers[event]?.(arg); },
  };
}

describe('redis connection', () => {
  let client: ReturnType<typeof fakeClient>;
  beforeEach(() => {
    __resetRedisForTest();
    saveAppConfig({ clearRedisUrl: true });
    client = fakeClient();
    __setRedisClientFactory(() => client as never);
  });
  afterEach(() => { __resetRedisForTest(); });

  test('no redisUrl configured -> startRedis is a no-op', () => {
    startRedis();
    expect(isRedisConnected()).toBe(false);
  });

  test('connects when a url is configured and the client signals ready', () => {
    saveAppConfig({ redisUrl: 'redis://127.0.0.1:6379' });
    startRedis();
    client.emit('ready');
    expect(isRedisConnected()).toBe(true);
  });

  test('a client error is recorded and never throws', () => {
    saveAppConfig({ redisUrl: 'redis://127.0.0.1:6379' });
    startRedis();
    client.emit('error', new Error('ECONNREFUSED'));
    expect(isRedisConnected()).toBe(false);
    expect(getRedisStatus().lastError).toContain('ECONNREFUSED');
  });

  test('redisPublish forwards to xadd when connected', async () => {
    saveAppConfig({ redisUrl: 'redis://127.0.0.1:6379' });
    startRedis();
    client.emit('ready');
    await redisPublish('narya:test:events', '100-0', '{"v":1}');
    expect(client.xaddCalls[0]).toEqual(['narya:test:events', 'MINID', '~', '100-0', '*', 'v', '{"v":1}']);
  });

  test('stopRedis disconnects and marks down', () => {
    saveAppConfig({ redisUrl: 'redis://127.0.0.1:6379' });
    startRedis();
    client.emit('ready');
    stopRedis();
    expect(isRedisConnected()).toBe(false);
  });

  // F1: new Redis(url) throws synchronously for a scheme-valid but malformed URL.
  // startRedis() runs in server.listen ahead of music/heartbeat/ads/wind-down/EventSub,
  // so it must degrade to a no-op rather than aborting the rest of boot.
  test('startRedis degrades to a no-op when the client factory throws (never aborts boot)', () => {
    const errors: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };
    try {
      saveAppConfig({ redisUrl: 'redis://127.0.0.1:6379' });
      __setRedisClientFactory(() => { throw new Error('bad url'); });
      expect(() => startRedis()).not.toThrow();
    } finally {
      console.error = originalError;
    }
    expect(isRedisConnected()).toBe(false);
    expect(getRedisStatus().lastError).toContain('bad url');
    // F6: the construction failure is logged (message only) — and never the URL/host.
    expect(errors.some(a => String(a[0]).includes('Redis connection error') && String(a[1]).includes('bad url'))).toBe(true);
    expect(JSON.stringify(errors)).not.toContain('127.0.0.1');
  });

  // F3: a rejecting xadd must surface (redisPublish rejects) and record lastPublishError,
  // which Task 8's toast reads.
  test('redisPublish rejects and records lastPublishError when xadd rejects', async () => {
    const rejecting = { ...fakeClient(), async xadd() { throw new Error('WRONGTYPE stream'); } };
    __setRedisClientFactory(() => rejecting as never);
    saveAppConfig({ redisUrl: 'redis://127.0.0.1:6379' });
    startRedis();
    rejecting.emit('ready');
    await expect(redisPublish('narya:test:events', '100-0', '{"v":1}')).rejects.toThrow('WRONGTYPE stream');
    expect(getRedisStatus().lastPublishError).toContain('WRONGTYPE stream');
  });

  // F5: turning Redis off clears a stale publish error so an inline alert/toast does not
  // keep reporting a failure against a service that is no longer on.
  test('stopRedis clears a stale lastPublishError', async () => {
    const rejecting = { ...fakeClient(), async xadd() { throw new Error('boom'); } };
    __setRedisClientFactory(() => rejecting as never);
    saveAppConfig({ redisUrl: 'redis://127.0.0.1:6379' });
    startRedis();
    rejecting.emit('ready');
    await redisPublish('k', '0-0', 'v').catch(() => {});
    expect(getRedisStatus().lastPublishError).toBeTruthy();
    stopRedis();
    expect(getRedisStatus().lastPublishError).toBeNull();
  });
});

// The stream prefix is the ONE source of truth shared by the outbound events stream
// (eventBus.streamKey) and the inbound per-app streams. Under `bun test` NODE_ENV=test,
// so with no explicit STREAMER_TOOLS_REDIS_PREFIX the prefix must be `test` — the
// mechanism that keeps a dev box and prod off each other's streams on a shared redisUrl.
describe('stream keys', () => {
  test('streamPrefix resolves to NODE_ENV under bun test', () => {
    expect(streamPrefix()).toBe('test');
  });

  // The inbound stream key namespaces per app AND per prefix, so App-A's stream and
  // App-B's stream are distinct keys under the same prefix as the events stream.
  test('inboundKey namespaces per app under the shared prefix', () => {
    expect(inboundKey('app-a')).toBe('narya:test:inbound:app-a');
    expect(inboundKey('app-b')).toBe('narya:test:inbound:app-b');
    expect(inboundKey('app-a')).not.toBe(inboundKey('app-b'));
  });
});
