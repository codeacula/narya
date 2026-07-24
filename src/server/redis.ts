import Redis from 'ioredis';
import { appConfig } from './appConfig';

export type RedisClientLike = {
  on(event: string, cb: (arg?: unknown) => void): void;
  xadd(...args: unknown[]): Promise<string | null>;
  xreadgroup(...args: unknown[]): Promise<unknown>;
  xack(...args: unknown[]): Promise<number>;
  xautoclaim(...args: unknown[]): Promise<unknown>;
  xgroup(...args: unknown[]): Promise<unknown>;
  quit(): Promise<unknown>;
  disconnect(): void;
};

// Single source of truth for the dev/prod stream prefix. The isolation hazard is
// documented on eventBus.streamKey(): a dev box and production that share one redisUrl
// must NOT collide on a stream key, or a dev redeem reaches a prod consumer. Both the
// OUTBOUND events stream (`narya:<prefix>:events`) and the INBOUND per-app streams
// (`narya:<prefix>:inbound:<appId>`) derive their prefix here so the two can never
// drift. Resolution order: explicit STREAMER_TOOLS_REDIS_PREFIX, then NODE_ENV (so
// `bun test` gets `test`), then `prod` (never `dev`, so an unset prod box does not
// silently share the dev stream).
export function streamPrefix(): string {
  return process.env['STREAMER_TOOLS_REDIS_PREFIX'] ?? process.env['NODE_ENV'] ?? 'prod';
}

/** The per-app inbound stream an external app XADDs its events to. */
export function inboundKey(appId: string): string {
  return `narya:${streamPrefix()}:inbound:${appId}`;
}

let createClient: (url: string) => RedisClientLike = (url) =>
  new Redis(url, { lazyConnect: false, enableOfflineQueue: false, maxRetriesPerRequest: 1 }) as unknown as RedisClientLike;

// The inbound consumer's blocking XREADGROUP connection MUST NOT share the publish
// client — a BLOCK ties up the whole connection, which would stall every publish. It
// gets its own factory (and its own test seam). maxRetriesPerRequest is null because a
// blocking read is not a normal request-reply and must not be aborted by the retry cap.
let createInboundClient: (url: string) => RedisClientLike = (url) =>
  new Redis(url, { lazyConnect: false, enableOfflineQueue: false, maxRetriesPerRequest: null }) as unknown as RedisClientLike;

/** Constructs the dedicated consumer connection through the (swappable) factory. */
export function newRedisInboundClient(url: string): RedisClientLike {
  return createInboundClient(url);
}

let client: RedisClientLike | null = null;
const status = { connected: false, lastError: null as string | null, lastPublishError: null as string | null };

export function isRedisConnected(): boolean { return status.connected; }
export function getRedisStatus() { return { ...status }; }

export function startRedis(): void {
  if (client) return;                 // already started
  const url = appConfig.redisUrl;
  if (!url) return;                   // not configured -> true no-op
  let next: RedisClientLike;
  try {
    // new Redis(url) throws SYNCHRONOUSLY for a scheme-valid but malformed URL (e.g.
    // an unescaped special character in the password). startRedis() runs inside
    // server.listen, ahead of music, heartbeat, ads, wind-down, and EventSub, so an
    // escaping throw here would abort the rest of boot. Degrade to a no-op instead —
    // never throw out of startRedis(). The error text is logged but NEVER the URL.
    next = createClient(url);
    next.on('ready', () => { status.connected = true; status.lastError = null; });
    next.on('error', (err) => {
      const message = err instanceof Error ? err.message : String(err);
      status.lastError = message;
      console.error('Redis connection error:', message);
    });
    next.on('end', () => { status.connected = false; });
    next.on('close', () => { status.connected = false; });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    status.lastError = message;
    console.error('Redis connection error:', message);
    client = null;
    return;
  }
  client = next;
}

export function stopRedis(): void {
  const closing = client;
  client = null;
  status.connected = false;
  // Turning Redis off (or clearing the URL) must not leave a stale error behind that
  // an inline alert or toast would then report against a service that is no longer on.
  status.lastError = null;
  status.lastPublishError = null;
  if (!closing) return;
  try { closing.disconnect(); } catch { /* not connected */ }
}

export async function redisPublish(key: string, minId: string, value: string): Promise<void> {
  if (!client) throw new Error('Redis is not configured.');
  try {
    await client.xadd(key, 'MINID', '~', minId, '*', 'v', value);
    status.lastPublishError = null;
  } catch (error) {
    status.lastPublishError = error instanceof Error ? error.message : String(error);
    throw error;
  }
}

// Reconcile: start when newly configured, stop when cleared. Idempotent.
export function reconcileRedis(): void {
  stopRedis();
  startRedis();
}

// --- test seams ---
export function __setRedisClientFactory(factory: (url: string) => RedisClientLike): void { createClient = factory; }
export function __setRedisInboundClientFactory(factory: (url: string) => RedisClientLike): void { createInboundClient = factory; }
export function __resetRedisForTest(): void {
  stopRedis();
  status.lastError = null;
  status.lastPublishError = null;
}
