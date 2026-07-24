/**
 * OPT-IN integration smoke for the inbound consumer's LIVE Redis wiring
 * (XGROUP CREATE / XREADGROUP / XACK / XAUTOCLAIM). It is SKIPPED by default so the
 * in-memory `bun test` suite never depends on a running Redis.
 *
 * How to run it (needs a real Redis you can throw away — it writes only to
 * `narya:test:inbound:*` keys, isolated from prod by the `test` stream prefix):
 *
 *   STREAMER_TOOLS_CONSUME_INBOUND=1 \
 *   STREAMER_TOOLS_REDIS_SMOKE_URL=redis://127.0.0.1:6379 \
 *   bun test src/server/redisInboundSmoke.test.ts
 *
 * Both env vars are required:
 *  - STREAMER_TOOLS_REDIS_SMOKE_URL enables this file and points it at the broker.
 *  - STREAMER_TOOLS_CONSUME_INBOUND=1 is what makes startRedisInbound() actually run
 *    (it is a per-box deployment gate, read once at import — hence set on the command).
 *
 * NODE_ENV=test (bun sets it) keeps the DB in-memory and the stream prefix at `test`,
 * so this never touches the operator's data or their prod streams.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import Redis from 'ioredis';
import { createAction } from './actions';
import { createApp, declareAppEvent } from './apps';
import { saveAppConfig } from './appConfig';
import { initAutomation } from './automation';
import { createAutomationTrigger } from './automationTriggers';
import { config } from './config';
import { db } from './db';
import { inboundKey, streamPrefix } from './redis';
import { startRedisInbound, stopRedisInbound } from './redisInbound';
import { RuntimeState } from './runtime';

const SMOKE_URL = process.env['STREAMER_TOOLS_REDIS_SMOKE_URL'] ?? '';
const suite = SMOKE_URL ? describe : describe.skip;

async function poll<T>(fn: () => T, ok: (v: T) => boolean, timeoutMs = 4000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  // First tick immediately, then poll.
  for (;;) {
    const value = fn();
    if (ok(value)) return value;
    if (Date.now() > deadline) return value;
    await new Promise(r => setTimeout(r, 50));
  }
}

suite('inbound consumer (live Redis smoke)', () => {
  let raw: Redis;
  let appId = '';
  let triggerId = '';

  beforeAll(async () => {
    // Fail loudly if the consume gate was not set, rather than silently doing nothing.
    expect(config.consumeInbound).toBe(true);
    expect(streamPrefix()).toBe('test');

    raw = new Redis(SMOKE_URL, { maxRetriesPerRequest: 1 });
    saveAppConfig({ redisUrl: SMOKE_URL });
    initAutomation(new RuntimeState());

    appId = createApp('smokeapp').id;
    declareAppEvent(appId, 'ping');
    // The step type is irrelevant to the wiring under test: whether it runs or is
    // skipped, invoke() inserts the automation_runs row (with the dedupe key) BEFORE
    // executing, which is the proof the entry was consumed and dispatched.
    const actionId = createAction({
      name: 'Smoke action',
      description: '',
      enabled: true,
      steps: [{ type: 'send_chat', enabled: true, delayMs: 0, payload: { message: 'pong' } }],
    }).id;
    triggerId = createAutomationTrigger({
      kind: 'redis_event',
      name: 'Smoke trigger',
      moduleId: null,
      enabled: true,
      globalCooldownMs: 0,
      userCooldownMs: 0,
      config: { appId, eventName: 'ping' },
      actions: [{ actionId, position: 0, enabled: true }],
      conditions: [],
    }).id;

    // Start clean: remove any stream left by a prior run.
    await raw.del(inboundKey(appId)).catch(() => {});
  });

  afterAll(async () => {
    stopRedisInbound();
    if (raw) {
      await raw.del(inboundKey(appId)).catch(() => {});
      raw.disconnect();
    }
  });

  test('consumes an XADDed declared event, dispatches it, and ACKs it (dedup on redelivery)', async () => {
    startRedisInbound();
    // Give the loop a beat to XGROUP CREATE MKSTREAM before we publish. (MKSTREAM on the
    // consumer side handles a missing stream; publishing after the group exists is what
    // an at-least-once broker guarantees delivery for.)
    await new Promise(r => setTimeout(r, 300));

    const key = inboundKey(appId);
    const envelope = JSON.stringify({ type: 'ping', id: 'evt-smoke-1', data: { hello: 'world' } });
    await raw.xadd(key, '*', 'v', envelope);

    const dedupeKey = `${triggerId}:${appId}:evt-smoke-1`;
    const runCount = db.prepare('select count(*) as n from automation_runs where dedupe_key = ?');

    const row = await poll(() => runCount.get(dedupeKey) as { n: number }, v => v.n >= 1);
    expect(row.n).toBe(1);

    // XACK happened after dispatch: no pending entries remain for the group. xpending's
    // first element is the count of pending entries; poll it down to 0.
    let pendingCount = -1;
    for (const deadline = Date.now() + 2000; Date.now() <= deadline; ) {
      const pending = (await raw.xpending(key, 'narya-inbound')) as unknown[];
      pendingCount = Number(pending[0]);
      if (pendingCount === 0) break;
      await new Promise(r => setTimeout(r, 50));
    }
    expect(pendingCount).toBe(0);

    // Redelivery of the SAME app id must NOT create a second run (dedup via the claim).
    await raw.xadd(key, '*', 'v', envelope);
    await new Promise(r => setTimeout(r, 500));
    expect((runCount.get(dedupeKey) as { n: number }).n).toBe(1);
  });
});
