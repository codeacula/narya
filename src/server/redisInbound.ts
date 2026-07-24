/**
 * Inbound Redis consumer (Phase C1).
 *
 * A registered external app XADDs events to its own per-app stream
 * `narya:<prefix>:inbound:<appId>`. This module reads those streams as a consumer
 * group and turns each entry into a `redis_event` trigger run — but only through the
 * dispatcher's SAFE step subset, because the payload is attacker-controlled and
 * crosses a trust boundary.
 *
 * Two halves:
 *  - `processInboundEntry` — the PURE decision core. Parse → bound → require a declared
 *    `type` → build a namespaced `RedisEventSignal`. No Redis, no DB (the declaration
 *    check is injected), so it is unit-tested directly.
 *  - the live loop — `XGROUP CREATE … MKSTREAM`, `XAUTOCLAIM` (crash recovery),
 *    `XREADGROUP … BLOCK`, `XACK` after dispatch. Gated on `config.consumeInbound &&
 *    appConfig.redisUrl`; a detached, never-throwing, idempotently start/stoppable task.
 *
 * Boot safety: `startRedisInbound()` runs inside `server.listen` right after
 * `startRedis()`, ahead of music/heartbeat/ads/wind-down/EventSub. It must NEVER throw —
 * construction is wrapped, connection is lazy, errors are swallowed to a no-op, and the
 * `redisUrl` is never logged.
 */
import { listApps } from './apps';
import { isDeclaredEvent, recordDataKeys as recordDataKeysReal } from './apps';
import { appConfig } from './appConfig';
import { getTriggerDispatcher } from './automation';
import { config } from './config';
import { inboundKey, newRedisInboundClient, type RedisClientLike } from './redis';
import type { RedisEventSignal } from './triggerDispatcher';

// The app XADDs a single field `v` holding this JSON envelope. `type` is the event
// name; `id` is the optional app-supplied dedup id; `data` is the payload. `source`,
// `version`, and `ts` MAY be present but are IGNORED for trust — provenance is which
// app stream the entry arrived on, never the self-declared `source`.
const ENVELOPE_FIELD = 'v';

// The payload crosses a trust boundary: bound it so a malicious app cannot exhaust
// memory or the template renderer. 16 KB of serialized `data`, and a top-level field
// count cap as a secondary guard.
const MAX_DATA_BYTES = 16 * 1024;
const MAX_FIELD_COUNT = 100;

export type InboundEntryContext = {
  appId: string;
  /** Injected predicate — the live loop passes `(name) => isDeclaredEvent(appId, name)`. */
  isDeclared: (eventName: string) => boolean;
  /** The Redis stream entry id (`<ms>-<seq>`), the dedup fallback when the app omits `id`. */
  streamEntryId: string;
};

export type InboundDecision = { drop: true } | { dispatch: RedisEventSignal };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The app-supplied dedup id, or null when absent/blank so the caller falls back. */
function dedupId(raw: unknown): string | null {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    return trimmed || null;
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  return null;
}

/**
 * The pure decision core. Given a raw `v` field value and `{ appId, isDeclared,
 * streamEntryId }`, returns either a drop or the signal to dispatch.
 *
 * Order (from the C1 spec):
 *  1. parse JSON — bad JSON / non-object → drop
 *  2. bound — serialized `data` over the size cap OR field count over the cap → drop
 *  3. require a non-blank `type` that passes the declaration check → else drop
 *  4. build the signal with `eventName = type`, `data = data ?? {}`, and the NAMESPACED
 *     `eventId = ${appId}:${envelope.id ?? streamEntryId}` — namespacing by appId is what
 *     makes cross-app suppression impossible: App-A's id can never collide with App-B's.
 */
export function processInboundEntry(rawValue: unknown, ctx: InboundEntryContext): InboundDecision {
  if (typeof rawValue !== 'string') return { drop: true };

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawValue);
  } catch {
    return { drop: true };
  }
  if (!isPlainObject(parsed)) return { drop: true };

  // Bound BEFORE coercion: a huge non-object `data` (e.g. a 20 KB string) must be
  // caught by the size cap rather than silently coerced away.
  const rawData = parsed['data'];
  let serialized: string;
  try {
    serialized = JSON.stringify(rawData ?? {});
  } catch {
    return { drop: true };
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_DATA_BYTES) return { drop: true };

  const data = isPlainObject(rawData) ? rawData : {};
  if (Object.keys(data).length > MAX_FIELD_COUNT) return { drop: true };

  const type = typeof parsed['type'] === 'string' ? parsed['type'].trim() : '';
  if (!type || !ctx.isDeclared(type)) return { drop: true };

  const eventId = `${ctx.appId}:${dedupId(parsed['id']) ?? ctx.streamEntryId}`;

  const signal: RedisEventSignal = {
    appId: ctx.appId,
    eventName: type,
    eventId,
    data,
  };
  // Reserved keys (spec §3): lift `actor`/`login` out of the payload so the editor's
  // actor/login conditions and {actor}/{login} tokens resolve inbound. LIFTED, not moved —
  // the keys stay in `data` so {data.actor} renders the same value. Only strings are
  // lifted; a non-string reserved key leaves the field ABSENT ("otherwise absent").
  if (typeof data['actor'] === 'string') signal.actor = data['actor'];
  if (typeof data['login'] === 'string') signal.login = data['login'];

  return { dispatch: signal };
}

// --- live loop ---

const GROUP = 'narya-inbound';
// One consumer name per process. Uniqueness only matters for XAUTOCLAIM ownership and
// pending-entry attribution; a pid is sufficient for a single-box deployment.
const CONSUMER = `narya-${process.pid}`;
const READ_COUNT = 50;
// The BLOCK window also bounds how quickly a newly-registered (or re-enabled) app is
// picked up: the app list is re-read once per loop iteration, and BLOCK is how long an
// idle iteration waits. 5s is a fine responsiveness/idle-wakeup tradeoff.
const BLOCK_MS = 5000;
// After a read error (a disconnect that is not a clean stop) back off before retrying,
// so a persistently-down Redis does not spin the loop.
const BACKOFF_MS = 2000;

let running = false;
let client: RedisClientLike | null = null;
// Apps whose consumer group has been created and whose startup XAUTOCLAIM has run.
const preparedApps = new Set<string>();

function logInboundError(context: string, error: unknown): void {
  // Message only — NEVER the redisUrl (which is never in an error here anyway, but the
  // discipline matches startRedis()).
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Redis inbound ${context}:`, message);
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isBusyGroup(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('BUSYGROUP');
}

/** Pull the `v` field out of a flat `[field, value, field, value, …]` entry array. */
function fieldValue(fields: unknown, name: string): unknown {
  if (!Array.isArray(fields)) return undefined;
  for (let i = 0; i + 1 < fields.length; i += 2) {
    if (fields[i] === name) return fields[i + 1];
  }
  return undefined;
}

// Indirected through a mutable local rather than called via the `./apps` import
// directly, ONLY so a test can inject a throwing collaborator deterministically:
// mock.module cannot reliably re-link a module another test file already loaded
// (see eventBus.test.ts), and redisInboundSmoke.test.ts statically imports this
// file regardless of its describe.skip. Production always runs the real one.
let recordDataKeys = recordDataKeysReal;
/** Test-only seam — swap (or restore) the learn call's implementation. */
export function __setRecordDataKeysForTest(fn: typeof recordDataKeysReal): void {
  recordDataKeys = fn;
}

/**
 * Process one stream entry: decide, dispatch if warranted, then ALWAYS XACK. The XACK
 * happens AFTER the dispatch — the dispatch's own `claim()` is what dedups, so a crash
 * between dispatch and XACK leaves the entry pending, XAUTOCLAIM recovers it, and the
 * dedup key makes the reprocess a no-op (at-least-once). A throw processing ONE entry
 * is caught, that entry is XACKed and skipped, and the loop continues — one poison
 * entry never stalls the stream.
 */
export async function handleEntry(c: RedisClientLike, appId: string, key: string, entryId: string, fields: unknown): Promise<void> {
  try {
    const decision = processInboundEntry(fieldValue(fields, ENVELOPE_FIELD), {
      appId,
      isDeclared: (name) => isDeclaredEvent(appId, name),
      streamEntryId: entryId,
    });
    if ('dispatch' in decision) {
      await getTriggerDispatcher().handleRedisEvent(decision.dispatch);
    }
    await c.xack(key, GROUP, entryId);
    // Auto-learn the payload's key catalog. AFTER the XACK and in its own try/catch:
    // learning is advisory bookkeeping, so it must never delay a fire, affect the
    // XACK, or fall into the outer catch (which would log an entry error and XACK
    // a second time). Only a dispatched — declared, well-formed, in-bounds — entry
    // learns; a dropped entry never touches the catalog.
    if ('dispatch' in decision) {
      try {
        recordDataKeys(appId, decision.dispatch.eventName, decision.dispatch.data);
      } catch (error) {
        logInboundError('catalog', error);
      }
    }
  } catch (error) {
    logInboundError('entry', error);
    try {
      await c.xack(key, GROUP, entryId);
    } catch {
      // Best effort: if the XACK itself fails (e.g. a dropped connection), the entry
      // stays pending and XAUTOCLAIM recovers it later. Do not rethrow — the loop must
      // not stall on one entry.
    }
  }
}

/**
 * Crash recovery: claim and reprocess this consumer group's pending entries left by a
 * prior crash (delivered-but-not-XACKed). Runs once per app when it is first prepared.
 */
async function claimPending(c: RedisClientLike, appId: string, key: string): Promise<void> {
  let cursor = '0-0';
  do {
    const result = (await c.xautoclaim(key, GROUP, CONSUMER, 0, cursor, 'COUNT', READ_COUNT)) as
      | [string, Array<[string, unknown]>, ...unknown[]]
      | null;
    if (!Array.isArray(result)) break;
    cursor = typeof result[0] === 'string' ? result[0] : '0-0';
    const entries = Array.isArray(result[1]) ? result[1] : [];
    for (const entry of entries) {
      if (!Array.isArray(entry)) continue;
      const [entryId, fields] = entry;
      if (typeof entryId !== 'string') continue;
      await handleEntry(c, appId, key, entryId, fields);
    }
  } while (running && cursor && cursor !== '0-0');
}

/**
 * Reconcile the consumer group against the current app roster and return the streams to
 * read this iteration. Re-read every iteration so an app registered (or re-enabled) at
 * runtime is picked up without a redisUrl reconcile or a restart. A disabled app is
 * dropped from the read set and forgotten, so re-enabling it re-runs group creation and
 * crash recovery.
 */
async function prepareApps(c: RedisClientLike): Promise<Array<{ appId: string; key: string }>> {
  const active: Array<{ appId: string; key: string }> = [];
  for (const app of listApps()) {
    if (app.disabledAt) {
      preparedApps.delete(app.id);
      continue;
    }
    const key = inboundKey(app.id);
    if (!preparedApps.has(app.id)) {
      try {
        await c.xgroup('CREATE', key, GROUP, '$', 'MKSTREAM');
      } catch (error) {
        if (!isBusyGroup(error)) throw error; // BUSYGROUP = group already exists (expected)
      }
      await claimPending(c, app.id, key);
      preparedApps.add(app.id);
    }
    active.push({ appId: app.id, key });
    if (!running) break;
  }
  return active;
}

/** Parse and process an XREADGROUP result: `[[streamKey, [[entryId, fields], …]], …]`. */
async function processReadResult(c: RedisClientLike, result: unknown, active: Array<{ appId: string; key: string }>): Promise<void> {
  if (!Array.isArray(result)) return;
  const appByKey = new Map(active.map(a => [a.key, a.appId]));
  for (const stream of result) {
    if (!Array.isArray(stream)) continue;
    const [streamKey, entries] = stream;
    const appId = typeof streamKey === 'string' ? appByKey.get(streamKey) : undefined;
    if (!appId || !Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!Array.isArray(entry)) continue;
      const [entryId, fields] = entry;
      if (typeof entryId !== 'string') continue;
      await handleEntry(c, appId, streamKey as string, entryId, fields);
      if (!running) return;
    }
  }
}

async function runLoop(c: RedisClientLike): Promise<void> {
  while (running && client === c) {
    try {
      const active = await prepareApps(c);
      if (!running || client !== c) break;
      if (active.length === 0) {
        // No registered app to consume — idle until the next iteration re-checks.
        await delay(BLOCK_MS);
        continue;
      }
      const streams = active.map(a => a.key);
      const cursors = active.map(() => '>');
      const result = await c.xreadgroup(
        'GROUP', GROUP, CONSUMER,
        'COUNT', READ_COUNT,
        'BLOCK', BLOCK_MS,
        'STREAMS', ...streams, ...cursors,
      );
      if (result) await processReadResult(c, result, active);
    } catch (error) {
      // A transient read error (a disconnect, including the one stopRedisInbound()
      // triggers to interrupt the BLOCK) must not kill the loop uncaught. If we were
      // asked to stop, the while guard exits; otherwise log the message and back off.
      if (running && client === c) {
        logInboundError('read', error);
        await delay(BACKOFF_MS);
      }
    }
  }
}

/**
 * Start the inbound consumer. Idempotent (a second call while running is a no-op), and
 * a TRUE no-op when the gate is off (`consumeInbound` unset, or no `redisUrl`) so a dev
 * box never joins the operator's real consumer group. NEVER throws.
 */
export function startRedisInbound(): void {
  if (running) return;                 // already running -> one consumer
  if (!config.consumeInbound) return;  // deployment gate -> true no-op
  const url = appConfig.redisUrl;
  if (!url) return;                    // not configured -> true no-op

  let next: RedisClientLike;
  try {
    // new Redis(url) can throw SYNCHRONOUSLY for a scheme-valid but malformed URL. This
    // runs in server.listen ahead of the rest of boot, so degrade to a no-op rather than
    // aborting it. The error text is logged but NEVER the URL.
    next = newRedisInboundClient(url);
    next.on('error', (err) => { logInboundError('connection error', err); });
  } catch (error) {
    logInboundError('connection error', error);
    client = null;
    return;
  }

  client = next;
  running = true;
  preparedApps.clear();
  // Detached: server.listen's callback must never block on the blocking read loop. A
  // rejection from the loop is caught here so it can never become an unhandled rejection.
  void runLoop(next).catch(error => { logInboundError('loop', error); });
}

/**
 * Stop the inbound consumer. Idempotent. Clears the running flag (the loop's while guard
 * exits) and disconnects the consumer client, which interrupts an in-flight BLOCK.
 */
export function stopRedisInbound(): void {
  running = false;
  const closing = client;
  client = null;
  preparedApps.clear();
  if (!closing) return;
  try { closing.disconnect(); } catch { /* not connected */ }
}
