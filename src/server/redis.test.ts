import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { saveAppConfig } from './appConfig';
import { __resetRedisForTest, __setRedisClientFactory, getRedisStatus, isRedisConnected, redisPublish, startRedis, stopRedis } from './redis';

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
});
