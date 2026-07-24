# Phase C1 — Inbound Redis Triggers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An external app writes events to its per-app Redis stream; Narya (gated behind `STREAMER_TOOLS_CONSUME_INBOUND`, registration-gated via `app_events`, poison-isolated, deduped) fires operator-authored `redis_event` triggers whose Actions are restricted to a **server-enforced safe step subset**, rendering attacker-controlled `{data.*}` safely.

**Architecture:** A new `redisInbound.ts` consumer (its own Redis client, decision-core behind a port) reads `narya:<env>:inbound:<appId>` and calls `getTriggerDispatcher().handleRedisEvent(...)`. `redis_event` is a new trigger kind bound to `(appId, eventName)`. The safe subset is enforced at run time in the executor via an `allowedStepTypes` set threaded from `invoke()` (set only for `redis_event`). `{data.*}` is a new template token family. All changes are additive.

**Tech Stack:** Bun + TypeScript, Express, `bun:sqlite` (`db.ts`), `ioredis`, React (client), `bun test`.

## Global Constraints

- **Fully optional + dev-safe:** the inbound consumer starts only when `config.consumeInbound` is true AND `redisUrl` is set. A `bun run dev` box never joins the operator's real consumer group or fires real triggers.
- **Registration gate:** the consumer **drops any event whose `type` isn't in that app's declared `app_events` set**; the envelope's self-declared `source` grants no privilege — provenance is the `appId` stream it arrived on.
- **Safe step subset (server-enforced, run-time):** a `redis_event`-sourced run may only execute `show_text`/`play_media`/`tts_speak`/`adjust_counter`/`send_chat`; every other step type is **skipped** (broadcasts nothing). Enforced in the executor keyed on an `allowedStepTypes` set, set only when `trigger.kind === 'redis_event'` — so even an Action later edited to add `twitch_ban` can never be triggered inbound.
- **Dedup key `${trigger.id}:${appId}:${appSuppliedId}`** (envelope `id`, else the unpredictable Redis stream-entry id) — the `appId` namespacing makes cross-app suppression impossible.
- **Poison isolation:** a bad-JSON / oversized / undeclared entry is skipped per-entry and `XACK`ed; it never stalls the loop. Entry `data` + field counts are bounded.
- **`XACK` only after `claim()` inserts** (at-least-once + dedup); **`XAUTOCLAIM` on startup** recovers pending entries.
- **`{data.*}` is attacker-controlled:** single-pass render (no re-expansion); non-scalar values coerce to a capped JSON string; missing key → empty; numeric `{data.*}` into `adjust_counter` flows through `parseCounterAmount` (already true).
- **The consumer is wired in `index.ts`** and calls `getTriggerDispatcher()` from `automation.ts`; it is **never imported by `automation.ts`** (boot-cycle).
- Additive contract; new table via idempotent `create table if not exists`; FK cascade already enabled. Verify per task with `bun run typecheck` + the covering test; full `bun test` + `bun run build` at the end.

---

### Task 1: `app_events` table + repo + routes + `consumeInbound` flag

**Files:**
- Modify: `src/server/db.ts` (`app_events` table in the `apps` `db.exec` block; a `dropStaleAppEvents` guard + call)
- Modify: `src/server/apps.ts` (`app_events` repo fns + routes; `appExistsById`)
- Modify: `src/shared/api.ts` (`AppEvent`, `AppEventInput`)
- Modify: `src/server/config.ts` (`consumeInbound`)
- Test: `src/server/apps.test.ts` (extend)

**Interfaces:**
- Produces: table `app_events(app_id, event_name, data_schema_json, created_at)` PK `(app_id, event_name)`, FK `app_id`→`apps` cascade; `listAppEvents(appId): AppEvent[]`; `declareAppEvent(appId, eventName): AppEvent` (insert-or-ignore, validates the name); `removeAppEvent(appId, eventName): void`; `isDeclaredEvent(appId, eventName): boolean`; `appExistsById(appId): boolean`; routes `GET/POST /api/apps/:id/events`, `DELETE /api/apps/:id/events/:name`; `config.consumeInbound: boolean`.

- [ ] **Step 1: Write the failing test** — extend `src/server/apps.test.ts`:

```ts
import { appExistsById, declareAppEvent, isDeclaredEvent, listAppEvents, removeAppEvent } from './apps';

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
```

- [ ] **Step 2: Run to verify it fails** — `bun test src/server/apps.test.ts` → FAIL (fns missing).

- [ ] **Step 3: Implement**

`src/server/db.ts` — inside the `db.exec(\`…\`)` block holding `apps` (right after it):
```sql
  create table if not exists app_events (
    app_id text not null,
    event_name text not null,
    data_schema_json text not null default '{}',
    created_at text not null,
    primary key (app_id, event_name),
    foreign key (app_id) references apps(id) on delete cascade
  );
```
Add a `dropStaleAppEvents(db)` guard modeled on `dropStaleTriggerOverrides` (shipped columns `['app_id','created_at','data_schema_json','event_name']` + a composite-PK check for `{app_id, event_name}`; drop-and-recreate on mismatch, **no** ledger clear — no runOnce backfill). Call it on the guard shelf beside `dropStaleTriggerActions(db);`. Bump the "four places" cascade comment count.

`src/shared/api.ts` (in the App-registry block):
```ts
export type AppEvent = { appId: string; eventName: string; dataSchemaJson: string; createdAt: string };
export type AppEventInput = { eventName: string };
```

`src/server/apps.ts` — new statements + fns (mirror the existing idiom):
```ts
const EVENT_COLUMNS = 'app_id as appId, event_name as eventName, data_schema_json as dataSchemaJson, created_at as createdAt';
const listEventsRow = db.prepare(`select ${EVENT_COLUMNS} from app_events where app_id = ? order by event_name`);
const insertEvent = db.prepare(`insert or ignore into app_events (app_id, event_name, data_schema_json, created_at) values (?, ?, '{}', ?)`);
const deleteEvent = db.prepare('delete from app_events where app_id = ? and event_name = ?');
const eventExists = db.prepare('select 1 as present from app_events where app_id = ? and event_name = ?');
const appById = db.prepare('select 1 as present from apps where id = ?');

export function appExistsById(appId: string): boolean { return Boolean(appById.get(appId)); }
export function listAppEvents(appId: string): AppEvent[] { return listEventsRow.all(appId) as AppEvent[]; }
export function isDeclaredEvent(appId: string, eventName: string): boolean { return Boolean(eventExists.get(appId, eventName)); }
function normalizeEventName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!/^[a-z0-9_.-]{1,64}$/i.test(name)) throw new HttpRouteError(400, 'Event name must be 1-64 chars of a-z, 0-9, _ . or -.');
  return name;
}
export function declareAppEvent(appId: string, rawName: string): AppEvent {
  if (!appExistsById(appId)) throw new HttpRouteError(404, 'App not found.');
  const eventName = normalizeEventName(rawName);
  insertEvent.run(appId, eventName, new Date().toISOString());
  return { appId, eventName, dataSchemaJson: '{}', createdAt: new Date().toISOString() };
}
export function removeAppEvent(appId: string, eventName: string): void { deleteEvent.run(appId, eventName); }
```
Add routes inside `registerAppsRoutes`: `GET /api/apps/:id/events` → `listAppEvents(request.params.id)`; `POST /api/apps/:id/events` → `declareAppEvent(request.params.id, body.eventName)`; `DELETE /api/apps/:id/events/:name` → `removeAppEvent(...)` + 204.

`src/server/config.ts`: add `consumeInbound: process.env['STREAMER_TOOLS_CONSUME_INBOUND'] === '1',` (with the "per-box, cannot come from the DB" reasoning in a comment).

- [ ] **Step 4: Run to verify it passes** — `bun test src/server/apps.test.ts` + `bun run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add src/server/db.ts src/server/apps.ts src/shared/api.ts src/server/config.ts src/server/apps.test.ts
git commit -m "feat: app_events declaration table/repo/routes + consumeInbound flag"
```

---

### Task 2: `redis_event` trigger source (contract + validation)

**Files:**
- Modify: `src/shared/api.ts` (`AutomationTriggerKind`, `RedisEventTriggerConfig`, union member, `TemplateContext.data`)
- Modify: `src/server/automationTriggers.ts` (`TRIGGER_KINDS`, `normalizeConfig` case, `CONDITION_FIELDS`)
- Test: `src/server/automationTriggers.test.ts` (extend)

**Interfaces:**
- Consumes: `appExistsById`, `isDeclaredEvent` (Task 1).
- Produces: kind `'redis_event'`; `RedisEventTriggerConfig = { appId: string; eventName: string }`; `TemplateContext.data?: Record<string, unknown>`.

- [ ] **Step 1: Write the failing test** — in `automationTriggers.test.ts`: a `redis_event` trigger persists `{appId, eventName}`; `normalizeConfig` rejects an unknown `appId` and an undeclared `eventName`. (Seed an app + declared event first.)

- [ ] **Step 2: Run to verify it fails** — FAIL (kind unsupported).

- [ ] **Step 3: Implement**
- `src/shared/api.ts`: `AutomationTriggerKind` `| 'redis_event'`; `export type RedisEventTriggerConfig = { appId: string; eventName: string };`; add the union member (copy the exact 13-field shape, `kind: 'redis_event'; … config: RedisEventTriggerConfig`); add `data?: Record<string, unknown>;` to `TemplateContext` (with a doc comment: external inbound payload for `{data.*}`).
- `automationTriggers.ts`: `TRIGGER_KINDS` add `'redis_event'`; `CONDITION_FIELDS` add `redis_event: new Set(['actor', 'login'])` (conditions over `{data.*}` are C2). `normalizeConfig` add the case:
```ts
case 'redis_event': {
  const appId = requireText(config.appId, 64, 'A Redis-event trigger needs an app.');
  if (!appExistsById(appId)) throw new HttpRouteError(400, 'App not found.');
  const eventName = requireText(config.eventName, 64, 'A Redis-event trigger needs an event name.');
  if (!isDeclaredEvent(appId, eventName)) throw new HttpRouteError(400, `"${eventName}" is not a declared event for that app.`);
  return { appId, eventName } satisfies RedisEventTriggerConfig;
}
```
  Import `appExistsById`/`isDeclaredEvent` from `./apps`.

- [ ] **Step 4: Run to verify it passes** — `bun test src/server/automationTriggers.test.ts` + `bun run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add src/shared/api.ts src/server/automationTriggers.ts src/server/automationTriggers.test.ts
git commit -m "feat: redis_event trigger kind bound to (appId, eventName)"
```

---

### Task 3: `{data.*}` template extension

**Files:**
- Modify: `src/server/actionTemplates.ts` (`TOKEN_PATTERN`, `DATA_TOKEN_PATTERN`, `resolveToken`, `isKnownToken`)
- Test: `src/server/actionTemplates.test.ts` (extend; create if absent)

**Interfaces:** consumes `TemplateContext.data` (Task 2).

- [ ] **Step 1: Write the failing test**:

```ts
test('{data.*} renders scalars, coerces non-scalars, empties missing, single-pass', () => {
  const ctx = { data: { boss: 'Dragon', hp: 100, evil: true, obj: { a: 1 }, arr: [1, 2], inject: '{actor}' } };
  expect(renderActionTemplate('Killed {data.boss} ({data.hp} hp)', ctx)).toBe('Killed Dragon (100 hp)');
  expect(renderActionTemplate('{data.evil}', ctx)).toBe('true');
  expect(renderActionTemplate('{data.obj}', ctx)).toBe('{"a":1}');          // JSON, not [object Object]
  expect(renderActionTemplate('{data.missing}', ctx)).toBe('');             // known family → empty, not literal
  expect(renderActionTemplate('{data.inject}', { actor: 'ADMIN', data: { inject: '{actor}' } })).toBe('{actor}'); // single-pass: not re-expanded
});
```

- [ ] **Step 2: Run to verify it fails** — `{data.boss}` won't even match the pattern → renders literal → FAIL.

- [ ] **Step 3: Implement** in `actionTemplates.ts`:
- Widen `TOKEN_PATTERN` to admit `.`: `/\{([A-Za-z][A-Za-z0-9:.-]*)\}/g` (update the header comment to also name `.`).
- Add `const DATA_TOKEN_PATTERN = /^data\.([A-Za-z0-9_.-]+)$/;`
- In `resolveToken`, after the `restMatch` block:
```ts
const dataMatch = DATA_TOKEN_PATTERN.exec(token);
if (dataMatch) {
  const value = context.data?.[dataMatch[1]!];
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try { return JSON.stringify(value).slice(0, 500); } catch { return ''; }
}
```
- In `isKnownToken`, extend the `default` branch: `return ARG_TOKEN_PATTERN.test(token) || REST_TOKEN_PATTERN.test(token) || DATA_TOKEN_PATTERN.test(token);`

- [ ] **Step 4: Run to verify it passes** — `bun test src/server/actionTemplates.test.ts` + `bun run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add src/server/actionTemplates.ts src/server/actionTemplates.test.ts
git commit -m "feat: {data.*} template tokens (coerced, single-pass, missing->empty)"
```

---

### Task 4: safe step subset (executor + port + `invoke` threading)

**Files:**
- Modify: `src/server/actionExecutor.ts` (`ActionExecutor.runAction` + `runAction` + `runStep`)
- Modify: `src/server/triggerDispatcher.ts` (`TriggerDispatcherDeps.runAction`, `InvokeOptions`, the two `runAction` call sites)
- Modify: `src/server/automation.ts` (the `runAction` port closure)
- Test: `src/server/actionExecutor.test.ts` (extend)

**Interfaces:**
- Produces: `runAction(actionId, context, options?: { allowedStepTypes?: ReadonlySet<ActionStepType> })`; a step whose type isn't in `allowedStepTypes` → `skipped` (broadcasts nothing); `InvokeOptions.allowedStepTypes` forwarded to both `runAction` calls. **Default (no set) is unrestricted — existing sources unchanged.**

- [ ] **Step 1: Write the failing test** — in `actionExecutor.test.ts`: an Action with `[show_text, twitch_ban]` run with `{ allowedStepTypes: new Set(['show_text', ...]) }` → the `twitch_ban` step result is `skipped` (detail mentions not-permitted), the `show_text` runs; run without options → both run.

- [ ] **Step 2: Run to verify it fails** — options arg not accepted → FAIL.

- [ ] **Step 3: Implement**
- `actionExecutor.ts`: `ActionExecutor.runAction` gains `options?: { allowedStepTypes?: ReadonlySet<ActionStepType> }`; `runAction(actionId, context, options)` passes `options?.allowedStepTypes` into `runStep`. In `runStep`, add — **before** the disabled check's delay/dispatch (sibling to `if (!step.enabled) return result(skipped('Step is disabled.'));`):
```ts
if (allowedStepTypes && !allowedStepTypes.has(step.type)) {
  return result(skipped(`Step type "${step.type}" is not allowed from an external event.`));
}
```
  (Thread `allowedStepTypes` from `runAction` → `runStep`, e.g. as a param.)
- `triggerDispatcher.ts`: `TriggerDispatcherDeps.runAction` signature gains the optional `options`; `InvokeOptions` gains `allowedStepTypes?: ReadonlySet<ActionStepType>`; destructure it in `invoke()`; pass `{ allowedStepTypes }` to both `runAction(id, context, { allowedStepTypes })` and the override-fallback `runAction(action.actionId, context, { allowedStepTypes })`. Define `export const REDIS_SAFE_STEP_TYPES: ReadonlySet<ActionStepType> = new Set(['show_text', 'play_media', 'tts_speak', 'adjust_counter', 'send_chat']);` (used by Task 5's handler).
- `automation.ts`: the closure becomes `runAction: (actionId, context, options) => executor!.runAction(actionId, context, options)`.

- [ ] **Step 4: Run to verify it passes** — `bun test src/server/actionExecutor.test.ts src/server/triggerDispatcher.test.ts` + `bun run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add src/server/actionExecutor.ts src/server/triggerDispatcher.ts src/server/automation.ts src/server/actionExecutor.test.ts
git commit -m "feat: executor honors an allowedStepTypes subset (skips blocked steps)"
```

---

### Task 5: dispatcher `handleRedisEvent`

**Files:**
- Modify: `src/server/triggerDispatcher.ts` (`RedisEventSignal`, `handleRedisEvent`, `TriggerDispatcher` type)
- Test: `src/server/triggerDispatcher.test.ts` (extend)

**Interfaces:**
- Consumes: `REDIS_SAFE_STEP_TYPES` (Task 4), `TemplateContext.data` (Task 2), `listEnabledTriggersOfKind('redis_event')`.
- Produces: `handleRedisEvent(signal: RedisEventSignal): Promise<TriggerRunSummary[]>` where `RedisEventSignal = { appId, eventName, eventId: string | null, actor?: string, login?: string | null, data: Record<string, unknown> }`.

- [ ] **Step 1: Write the failing test** — a `redis_event` trigger bound to `(app, 'boss_killed')` with an Action `[show_text using {data.boss}, twitch_ban]`: `handleRedisEvent({ appId: app, eventName: 'boss_killed', eventId: 'x1', data: { boss: 'Dragon' } })` runs the `show_text` and **skips the `twitch_ban`** (assert via the run's step statuses / the safe-step block); a redelivery with the same `eventId` is a no-op (one `automation_runs` row); an event for an unbound `(appId,eventName)` fires nothing.

- [ ] **Step 2: Run to verify it fails** — `handleRedisEvent` missing → FAIL.

- [ ] **Step 3: Implement** — mirror `handleTwitchEvent`:
```ts
export type RedisEventSignal = { appId: string; eventName: string; eventId: string | null; actor?: string; login?: string | null; data: Record<string, unknown> };

async function handleRedisEvent(signal: RedisEventSignal): Promise<TriggerRunSummary[]> {
  const login = signal.login?.trim().toLowerCase() ?? '';
  const context: TemplateContext = {
    ...(signal.actor === undefined ? {} : { actor: signal.actor }),
    ...(login ? { login } : {}),
    data: signal.data,
  };
  const candidates = listEnabledTriggersOfKind('redis_event')
    .filter(trigger => trigger.kind === 'redis_event' && trigger.config.appId === signal.appId && trigger.config.eventName === signal.eventName)
    .map(trigger => ({ trigger, context }));
  return invokeAll(candidates, { eventId: signal.eventId, actorLogin: login || null, allowedStepTypes: REDIS_SAFE_STEP_TYPES });
}
```
  Add `handleRedisEvent` to the `TriggerDispatcher` type and the returned object literal. **Dedup:** the caller (Task 6) passes `signal.eventId = ${appId}:${appSuppliedId}` (or the stream id); combined with the existing `claim` key `${trigger.id}:${eventId}` this yields `${trigger.id}:${appId}:${appSuppliedId}` per the spec.

- [ ] **Step 4: Run to verify it passes** — `bun test src/server/triggerDispatcher.test.ts` + `bun run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add src/server/triggerDispatcher.ts src/server/triggerDispatcher.test.ts
git commit -m "feat: handleRedisEvent fires (appId,eventName) triggers, safe-subset only"
```

---

### Task 6: inbound consumer (`redisInbound.ts` + client extension + wiring)

**Files:**
- Modify: `src/server/redis.ts` (extend `RedisClientLike`; a second consumer-client factory + test seam)
- Create: `src/server/redisInbound.ts` (the consumer + a pure decision core)
- Modify: `src/server/index.ts` (start/stop the consumer; reconcile branch)
- Test: `src/server/redisInbound.test.ts` (new — the decision core with a fake stream)

**Interfaces:**
- Consumes: `getTriggerDispatcher().handleRedisEvent` (Task 5), `listApps`/`isDeclaredEvent` (Task 1), `config.consumeInbound`, `appConfig.redisUrl`.
- Produces: `startRedisInbound()`, `stopRedisInbound()`; a pure `processInboundEntry(rawValue, ctx): { drop: true } | { dispatch: RedisEventSignal }` decision core.

- [ ] **Step 1: Write the failing test** — `redisInbound.test.ts` unit-tests the **decision core** (no live Redis): given a raw envelope value + `{ appId, isDeclared, streamEntryId }`, it (a) drops non-JSON, (b) drops an entry whose serialized data exceeds the size cap, (c) drops an entry whose `type` isn't declared, (d) for a valid declared entry returns a `RedisEventSignal` with `eventId = ${appId}:${envelope.id ?? streamEntryId}` and `data = envelope.data`; and that two apps' identical `envelope.id` yield **different** `eventId`s (cross-app suppression impossible).

- [ ] **Step 2: Run to verify it fails** — module missing → FAIL.

- [ ] **Step 3: Implement**
- `redis.ts`: extend `RedisClientLike` with `xreadgroup`/`xack`/`xautoclaim`/`xgroup(...args: unknown[])`. Add a **separate** consumer-client factory + `__setRedisInboundClientFactory` test seam (a blocking `XREADGROUP` connection must not share the publish client). Export a small `inboundKey(appId)` using the shared `STREAM_PREFIX` (extract the prefix from `eventBus.ts` into a shared spot or re-derive identically).
- `redisInbound.ts`: a pure `processInboundEntry` (parse → bound size/fields → require non-blank declared `type` → build the `RedisEventSignal` with the namespaced `eventId`) — this is the unit-tested core. Plus the live loop (started only when `config.consumeInbound && appConfig.redisUrl`): for each non-disabled app, `XGROUP CREATE … MKSTREAM` (ignore BUSYGROUP), `XAUTOCLAIM` pending on startup, then `XREADGROUP … BLOCK` loop; per entry → `processInboundEntry` → drop+`XACK` or `await getTriggerDispatcher().handleRedisEvent(signal)` then `XACK` (after the dispatch, which claims). A throw in one entry is caught and the entry `XACK`ed/skipped so the loop never stalls. Lazy-connect + never-throw like `obs.ts`/`redis.ts`. `startRedisInbound`/`stopRedisInbound` are idempotent no-ops when the gate is off.
- `index.ts`: `import { startRedisInbound, stopRedisInbound } from './redisInbound';`; call `startRedisInbound()` right after `startRedis();` in the `server.listen` callback; in the `redis` reconcile branch, also `stopRedisInbound(); startRedisInbound();`.

- [ ] **Step 4: Run to verify it passes** — `bun test src/server/redisInbound.test.ts src/server/redis.test.ts` + `bun run typecheck`. (The live loop's `XREADGROUP`/`XACK`/`XAUTOCLAIM` wiring is covered by an opt-in integration smoke, env-flagged, not the in-memory suite — document how to run it.)

- [ ] **Step 5: Commit**

```bash
git add src/server/redis.ts src/server/redisInbound.ts src/server/index.ts src/server/redisInbound.test.ts
git commit -m "feat: inbound Redis consumer (gated, registration-gated, poison-isolated)"
```

---

### Task 7: editor — declare app events + bind a `redis_event` trigger

**Files:**
- Modify: `src/client/services/dashboard.ts` (`getAppEvents`/`declareAppEvent`/`removeAppEvent`)
- Modify: `src/client/pages/settings/AppsPage.tsx` (per-app event-name list)
- Modify: `src/client/pages/settings/AutomationPage.tsx` + `automation.ts` (the `redis_event` config editor: app picker + declared-event picker; `newTrigger` seeds the config; a save-time warning if the bound Action has blocked steps)
- Test: `src/client/pages/settings/automation.test.ts` (extend)

**Interfaces:** consumes `AppEvent`, `RedisEventTriggerConfig`, `getAppEvents`/`declareAppEvent`/`removeAppEvent`.

- [ ] **Step 1: Write the failing test** — in `automation.test.ts`: `newTrigger('redis_event')` seeds `config: { appId: '', eventName: '' }`; `validateTrigger` blocks an empty `appId`/`eventName`; `triggerToInput` round-trips the config. (UI rendering verified via typecheck/build.)

- [ ] **Step 2: Run to verify it fails** — no `redis_event` config handling → FAIL.

- [ ] **Step 3: Implement**
- `dashboard.ts`: `getAppEvents(appId)`, `declareAppEvent(appId, eventName)`, `removeAppEvent(appId, eventName)` (mirror `setAppDisabled`'s `encodeURIComponent` URL building).
- `AppsPage.tsx`: per app row, an inline declared-event list (load via `getAppEvents`) + an add-name input + per-event Remove (mirror the existing `counter-row` idiom).
- `automation.ts`: `newTrigger`'s `redis_event` case seeds `config: { appId: '', eventName: '' }`; `validateTrigger` requires both; a `REDIS_SAFE_STEP_TYPES` mirror + a non-blocking warning helper for a `redis_event` trigger whose bound Actions contain a blocked step type.
- `AutomationPage.tsx`: the `redis_event` config editor — an app `<select>` (from `getApps`, enabled apps), then an event `<select>` (from `getAppEvents(appId)`); show the safe-subset warning when applicable.

- [ ] **Step 4: Run to verify it passes** — `bun test src/client/pages/settings/automation.test.ts` + `bun run typecheck` + `bun run build`. (No component harness — typecheck/build + automation.test.ts are the gates. Do NOT launch a live dev server.)

- [ ] **Step 5: Commit**

```bash
git add src/client/services/dashboard.ts src/client/pages/settings/AppsPage.tsx src/client/pages/settings/AutomationPage.tsx src/client/pages/settings/automation.ts src/client/pages/settings/automation.test.ts
git commit -m "feat: declare app events + bind a redis_event trigger in the editor"
```

---

## Final verification

- [ ] `bun run typecheck` · `bun test` · `bun run build` — all green.
- [ ] Manual (opt-in, real Redis + `STREAMER_TOOLS_CONSUME_INBOUND=1`): register app `pztmi`, declare `boss_killed`, bind a `redis_event` trigger to `(pztmi, boss_killed)` with a `show_text` Action using `{data.boss}`; `XADD narya:<env>:inbound:<pztmiId> * v '{"type":"boss_killed","id":"e1","data":{"boss":"Dragon"}}'`; confirm the overlay shows "Dragon" once; add a `twitch_ban` step and confirm it never fires inbound; re-`XADD` id `e1` → no second fire. With `consumeInbound` unset, confirm nothing is consumed.

## Spec coverage self-check

| Spec section | Task |
|---|---|
| §2 client + consumer (XREADGROUP/XACK/XAUTOCLAIM, poison, gate) | 6 |
| §3 redis_event source + dedup key | 2, 5, 6 |
| §4 {data.*} template extension | 3 |
| §5 safe step subset (dispatch-time) | 4, 5 |
| §6 app_events (event-name declaration) | 1, 7 |
| §7 config / dev-safety gate | 1, 6 |
| §8 testing (decision core, {data.*}, safe subset, dispatch, opt-in smoke) | 1–6 |
