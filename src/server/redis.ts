import Redis from 'ioredis';
import { appConfig } from './appConfig';

type RedisClientLike = {
  on(event: string, cb: (arg?: unknown) => void): void;
  xadd(...args: unknown[]): Promise<string | null>;
  quit(): Promise<unknown>;
  disconnect(): void;
};

let createClient: (url: string) => RedisClientLike = (url) =>
  new Redis(url, { lazyConnect: false, enableOfflineQueue: false, maxRetriesPerRequest: 1 }) as unknown as RedisClientLike;

let client: RedisClientLike | null = null;
const status = { connected: false, lastError: null as string | null, lastPublishError: null as string | null };

export function isRedisConnected(): boolean { return status.connected; }
export function getRedisStatus() { return { ...status }; }

export function startRedis(): void {
  if (client) return;                 // already started
  const url = appConfig.redisUrl;
  if (!url) return;                   // not configured -> true no-op
  const next = createClient(url);
  next.on('ready', () => { status.connected = true; status.lastError = null; });
  next.on('error', (err) => { status.lastError = err instanceof Error ? err.message : String(err); });
  next.on('end', () => { status.connected = false; });
  next.on('close', () => { status.connected = false; });
  client = next;
}

export function stopRedis(): void {
  const closing = client;
  client = null;
  status.connected = false;
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
export function __resetRedisForTest(): void {
  stopRedis();
  status.lastError = null;
  status.lastPublishError = null;
}
