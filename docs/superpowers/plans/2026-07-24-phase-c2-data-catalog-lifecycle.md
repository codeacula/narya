# Phase C2 — data-key catalog + lifecycle coupling: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `app_events.data_schema_json` into an auto-learned, typed data-key catalog per declared event; make `{data.*}` pickable and type-aware in the conditions editor; and flag `redis_event` triggers inert when their event is de-registered or their app is disabled.

**Architecture:** A pure catalog core (`appEventCatalog.ts`) does type inference + a cumulative, `changed`-gated merge. The inbound consumer calls a repo writer best-effort *after* XACK, so learning can never delay or break a fire. `data.*` conditions work via one branch in the pure `fieldValue` (the dispatcher is untouched, since C1 already puts `data` on the context). Lifecycle inertness is **computed at load**, never persisted.

**Tech Stack:** Bun, TypeScript (strict), SQLite (`bun:sqlite`), Express, React. Tests are `*.test.ts` colocated, run via `bun test` (in-memory DB under `NODE_ENV=test`).

## Global Constraints

- **No new column, no data migration.** `app_events.data_schema_json` already exists with default `'{}'`; an empty catalog is correct for every existing row.
- **Storage shape:** a flat JSON object `{ [dataKey: string]: 'string' | 'number' | 'boolean' }`. `'{}'` = no keys.
- **The catalog is cumulative** — a key absent from one payload is retained, never pruned.
- **Writes are `changed`-gated:** only write `data_schema_json` when a key was added or a type changed. Once converged, learning is a read-only no-op per entry.
- **Learning is best-effort and post-XACK.** It must never stall the consumer loop, delay a fire, affect XACK, or throw into `handleEntry`'s outer catch.
- **Only a dispatched entry learns.** A dropped entry (undeclared / oversized / poison) never touches the catalog.
- **The catalog is advisory, never a gate.** The C1 registration gate (event NAME must be declared) and the safe-step allowlist are UNCHANGED. `data.*` condition fields are validated by pattern, never against the catalog (auto-learn lags).
- **Inertness is computed, never persisted.** No flag column, no migration.
- **Server is the validation authority**; the client mirrors it. Type-based op filtering is a UI convenience only.
- **No import cycles.** `automationTriggers.ts` imports `apps.ts` (C1's `appExistsById`/`isDeclaredEvent`), so `apps.ts` must NEVER import `automationTriggers.ts` — both prepare SQLite statements at load time, so a cycle is a boot-order failure, not a clean error. Anything `apps.ts` needs about triggers is done with its own query.
- **No `json_extract`/JSON1.** The codebase uses it nowhere; parse JSON in JS, matching how `rowToTrigger` already reads config.
- `bun run typecheck` must be green at EVERY commit — never split a contract change from the code that satisfies it across two tasks.
- Match existing idioms: two-space indent, no linter. Client/server contracts live in `src/shared/api.ts`.

---

### Task 1: catalog contract + pure core (`appEventCatalog.ts`)

**Files:**
- Create: `src/server/appEventCatalog.ts`
- Create: `src/server/appEventCatalog.test.ts`
- Modify: `src/shared/api.ts` (add `AppEventDataKeyType`, `AppEventDataKey` ONLY — `AppEvent` itself changes in Task 2, so this task stays purely additive and typecheck stays green)

**Interfaces:**
- Produces: `inferKeyType(value: unknown): AppEventDataKeyType | null`, `mergeDataCatalog(stored, data): { catalog, changed }`, `parseDataCatalog(json: string): Record<string, AppEventDataKeyType>`, `catalogToDataKeys(catalog): AppEventDataKey[]`.
- Consumed by Tasks 2 (repo/wire) and 3 (consumer).

- [ ] **Step 1: Write the failing test** — `src/server/appEventCatalog.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { catalogToDataKeys, inferKeyType, mergeDataCatalog, parseDataCatalog } from './appEventCatalog';

describe('inferKeyType', () => {
  test('classifies scalars', () => {
    expect(inferKeyType('x')).toBe('string');
    expect(inferKeyType(3)).toBe('number');
    expect(inferKeyType(true)).toBe('boolean');
  });
  test('classifies a non-scalar as string (it renders as capped JSON)', () => {
    expect(inferKeyType({ a: 1 })).toBe('string');
    expect(inferKeyType([1, 2])).toBe('string');
  });
  test('skips null, undefined, and non-finite numbers', () => {
    expect(inferKeyType(null)).toBeNull();
    expect(inferKeyType(undefined)).toBeNull();
    expect(inferKeyType(Number.POSITIVE_INFINITY)).toBeNull();
    expect(inferKeyType(Number.NaN)).toBeNull();
  });
});

describe('mergeDataCatalog', () => {
  test('adds new keys and reports changed', () => {
    const r = mergeDataCatalog({}, { boss: 'Dragon', wave: 3 });
    expect(r.catalog).toEqual({ boss: 'string', wave: 'number' });
    expect(r.changed).toBe(true);
  });
  test('is a no-op when nothing is new', () => {
    const r = mergeDataCatalog({ boss: 'string' }, { boss: 'Hydra' });
    expect(r.changed).toBe(false);
    expect(r.catalog).toEqual({ boss: 'string' });
  });
  test('last-observed type wins on a conflict', () => {
    const r = mergeDataCatalog({ wave: 'string' }, { wave: 7 });
    expect(r.catalog).toEqual({ wave: 'number' });
    expect(r.changed).toBe(true);
  });
  test('retains keys absent from this payload (cumulative)', () => {
    const r = mergeDataCatalog({ boss: 'string', wave: 'number' }, { boss: 'Hydra' });
    expect(r.catalog).toEqual({ boss: 'string', wave: 'number' });
    expect(r.changed).toBe(false);
  });
  test('skips null/undefined values without marking changed', () => {
    const r = mergeDataCatalog({}, { boss: null, wave: undefined });
    expect(r.catalog).toEqual({});
    expect(r.changed).toBe(false);
  });
});

describe('parseDataCatalog', () => {
  test('parses a catalog and drops invalid entries', () => {
    expect(parseDataCatalog('{"boss":"string","bad":"weird","n":5}')).toEqual({ boss: 'string' });
  });
  test('malformed or non-object JSON reads as empty', () => {
    expect(parseDataCatalog('not json')).toEqual({});
    expect(parseDataCatalog('[]')).toEqual({});
    expect(parseDataCatalog('{}')).toEqual({});
  });
});

describe('catalogToDataKeys', () => {
  test('returns name-sorted keys', () => {
    expect(catalogToDataKeys({ wave: 'number', boss: 'string' })).toEqual([
      { name: 'boss', type: 'string' },
      { name: 'wave', type: 'number' },
    ]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test src/server/appEventCatalog.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/shared/api.ts` — add near the existing `AppEvent` declaration. **Do NOT touch `AppEvent` in this task** (Task 2 changes it together with the `apps.ts` mapping, so typecheck is green at every commit):

```ts
export type AppEventDataKeyType = 'string' | 'number' | 'boolean';
export type AppEventDataKey = { name: string; type: AppEventDataKeyType };
```

`src/server/appEventCatalog.ts`:

```ts
import type { AppEventDataKey, AppEventDataKeyType } from '../shared/api';

/**
 * The data-key catalog for one declared inbound event: a flat map of top-level
 * payload key -> coarse type, auto-learned by the inbound consumer. It is ADVISORY
 * — the editor uses it to offer keys and steer ops, but a condition on a key that
 * has not been observed yet is still valid (learning lags a newly-emitted key).
 */
export type DataCatalog = Record<string, AppEventDataKeyType>;

const VALID_TYPES = new Set<string>(['string', 'number', 'boolean']);

/**
 * The coarse type to record for an observed value, or null to skip it.
 * A non-scalar is recorded as 'string' because that is how {data.*} renders it
 * (a capped JSON string), so the editor's hint matches the actual render.
 */
export function inferKeyType(value: unknown): AppEventDataKeyType | null {
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return Number.isFinite(value) ? 'number' : null;
  if (typeof value === 'boolean') return 'boolean';
  if (value === null || value === undefined) return null;
  return 'string';
}

/**
 * Merge one observed payload into the stored catalog. Cumulative: a key absent from
 * THIS payload is retained (an event that sometimes omits a key must not lose it).
 * Last-observed type wins on a conflict. `changed` is true only when a key was added
 * or its type changed — the caller skips the write otherwise, so a converged schema
 * costs no writes.
 */
export function mergeDataCatalog(stored: DataCatalog, data: Record<string, unknown>): { catalog: DataCatalog; changed: boolean } {
  const catalog: DataCatalog = { ...stored };
  let changed = false;
  for (const [key, value] of Object.entries(data)) {
    const type = inferKeyType(value);
    if (!type) continue;
    if (catalog[key] !== type) {
      catalog[key] = type;
      changed = true;
    }
  }
  return { catalog, changed };
}

/** Read a stored data_schema_json. Total: malformed/non-object JSON and entries with
 *  an unrecognized type read as absent rather than throwing. */
export function parseDataCatalog(json: string): DataCatalog {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return {};
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const catalog: DataCatalog = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string' && VALID_TYPES.has(value)) catalog[key] = value as AppEventDataKeyType;
  }
  return catalog;
}

/** The wire view: name-sorted so the editor's picker order is stable. */
export function catalogToDataKeys(catalog: DataCatalog): AppEventDataKey[] {
  return Object.entries(catalog)
    .map(([name, type]) => ({ name, type }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test src/server/appEventCatalog.test.ts` — PASS. Then `bun run typecheck` — green (this task is purely additive).

- [ ] **Step 5: Commit**

```bash
git add src/shared/api.ts src/server/appEventCatalog.ts src/server/appEventCatalog.test.ts
git commit -m "feat: data-key catalog contract + pure inference/merge core"
```

---

### Task 2: `AppEvent.dataKeys` on the wire + `recordDataKeys` repo

**Files:**
- Modify: `src/shared/api.ts` (`AppEvent` gains `dataKeys`, drops `dataSchemaJson` — done HERE, with the mapping, so typecheck stays green)
- Modify: `src/server/apps.ts` (row mapping, `listAppEvents`, `declareAppEvent`, new `recordDataKeys`, new `countTriggersForEvent`)
- Test: `src/server/apps.test.ts` (extend)

**Contract change (`src/shared/api.ts`):**
```ts
export type AppEvent = { appId: string; eventName: string; dataKeys: AppEventDataKey[]; createdAt: string };
```
`dataSchemaJson` is removed from the wire — it has no client consumer (verified: referenced only in `api.ts`, `db.ts`, `apps.ts`). It remains the storage column.

**Interfaces:**
- Consumes: `parseDataCatalog`, `catalogToDataKeys`, `mergeDataCatalog` (Task 1).
- Produces: `recordDataKeys(appId, eventName, data): boolean` (true iff it wrote), `countTriggersForEvent(appId, eventName): number`.

**Context:** `apps.ts` currently returns rows straight from SQLite as `AppEvent` (`listAppEvents` at ~65, `declareAppEvent` at ~81 return `getEventRow.get(...) as AppEvent`). With `dataKeys` on the contract, they must map through a `rowToAppEvent`. `EVENT_COLUMNS` (~53) still selects `data_schema_json as dataSchemaJson` — keep selecting it as the *row* type, just don't return it.

- [ ] **Step 1: Write the failing test** — extend `src/server/apps.test.ts`:

```ts
test('a freshly declared event has an empty dataKeys catalog', () => {
  const app = createApp('catalogapp');
  const event = declareAppEvent(app.id, 'boss_killed');
  expect(event.dataKeys).toEqual([]);
  expect((event as unknown as Record<string, unknown>)['dataSchemaJson']).toBeUndefined();
});

test('recordDataKeys learns keys and is a no-op once converged', () => {
  const app = createApp('learnapp');
  declareAppEvent(app.id, 'boss_killed');

  expect(recordDataKeys(app.id, 'boss_killed', { boss: 'Dragon', wave: 3 })).toBe(true);
  expect(listAppEvents(app.id)[0]!.dataKeys).toEqual([
    { name: 'boss', type: 'string' },
    { name: 'wave', type: 'number' },
  ]);

  // Same shape again -> no write.
  expect(recordDataKeys(app.id, 'boss_killed', { boss: 'Hydra', wave: 9 })).toBe(false);
  // A new key -> write, and the old keys are retained.
  expect(recordDataKeys(app.id, 'boss_killed', { loot: true })).toBe(true);
  expect(listAppEvents(app.id)[0]!.dataKeys.map(k => k.name)).toEqual(['boss', 'loot', 'wave']);
});

test('recordDataKeys on an undeclared event writes nothing', () => {
  const app = createApp('nodeclapp');
  expect(recordDataKeys(app.id, 'never_declared', { a: 1 })).toBe(false);
});

test('countTriggersForEvent counts only redis_event triggers bound to that (app, event)', () => {
  const app = createApp('countapp');
  declareAppEvent(app.id, 'boss_killed');
  declareAppEvent(app.id, 'other_event');
  expect(countTriggersForEvent(app.id, 'boss_killed')).toBe(0);

  // Insert a redis_event trigger bound to (app, boss_killed) directly via the DB,
  // so this suite does not import automationTriggers.ts (that module imports THIS
  // one — see the cycle note in Step 3).
  const now = new Date().toISOString();
  db.prepare(
    `insert into automation_triggers (id, kind, action_id, module_id, enabled, config_json,
       global_cooldown_ms, user_cooldown_ms, created_at, updated_at)
     values (?, 'redis_event', ?, null, 1, ?, 0, 0, ?, ?)`,
  ).run(crypto.randomUUID(), someActionId, JSON.stringify({ appId: app.id, eventName: 'boss_killed' }), now, now);

  expect(countTriggersForEvent(app.id, 'boss_killed')).toBe(1);
  expect(countTriggersForEvent(app.id, 'other_event')).toBe(0);
  expect(countTriggersForEvent('someone-else', 'boss_killed')).toBe(0);
});
```
`someActionId` must be a real `actions.id` (the `action_id` FK is NOT NULL with a cascade FK) — create one with this suite's existing Action helper, or insert a minimal `actions` row first.

- [ ] **Step 2: Run to verify it fails**

Run: `bun test src/server/apps.test.ts` — FAIL (`recordDataKeys`/`countTriggersForEvent` undefined; `dataKeys` undefined).

- [ ] **Step 3: Implement** — in `src/server/apps.ts`:

```ts
import { catalogToDataKeys, mergeDataCatalog, parseDataCatalog } from './appEventCatalog';

type AppEventRow = { appId: string; eventName: string; dataSchemaJson: string; createdAt: string };

function rowToAppEvent(row: AppEventRow): AppEvent {
  return {
    appId: row.appId,
    eventName: row.eventName,
    dataKeys: catalogToDataKeys(parseDataCatalog(row.dataSchemaJson)),
    createdAt: row.createdAt,
  };
}

const updateEventSchema = db.prepare('update app_events set data_schema_json = ? where app_id = ? and event_name = ?');
// Raw config_json, compared in JS. Two deliberate choices:
//  - NO json_extract: the codebase uses SQLite's JSON1 nowhere else; parsing in JS
//    keeps this query portable and matches how rowToTrigger already reads config.
//  - NO import from automationTriggers.ts: that module imports THIS one
//    (appExistsById/isDeclaredEvent, C1), so reaching back would close an import
//    cycle between two modules that both prepare statements at load time.
// The redis_event trigger count is tiny, so scanning them is free.
const selectRedisTriggerConfigs = db.prepare(`select config_json as configJson from automation_triggers where kind = 'redis_event'`);
```
Change `listAppEvents` to `return (listEventsRow.all(appId) as AppEventRow[]).map(rowToAppEvent);` and `declareAppEvent`'s return to `rowToAppEvent(getEventRow.get(appId, eventName) as AppEventRow)`.

```ts
/**
 * Record the top-level keys of one observed payload into the event's catalog.
 * Returns true iff it wrote. Cumulative and changed-gated, so a converged schema
 * costs a read and nothing else. An undeclared (app, event) writes nothing — only
 * a dispatched, declared event learns.
 */
export function recordDataKeys(appId: string, eventName: string, data: Record<string, unknown>): boolean {
  const row = getEventRow.get(appId, eventName) as AppEventRow | undefined;
  if (!row) return false;
  const { catalog, changed } = mergeDataCatalog(parseDataCatalog(row.dataSchemaJson), data);
  if (!changed) return false;
  updateEventSchema.run(JSON.stringify(catalog), appId, eventName);
  return true;
}

/** How many redis_event triggers are bound to this (app, event) — drives the
 *  AppsPage "N triggers reference this" hint before a de-registration. Total: a
 *  trigger whose config_json is unreadable is simply not counted. */
export function countTriggersForEvent(appId: string, eventName: string): number {
  const rows = selectRedisTriggerConfigs.all() as { configJson: string }[];
  let n = 0;
  for (const row of rows) {
    try {
      const config = JSON.parse(row.configJson) as { appId?: unknown; eventName?: unknown };
      if (config.appId === appId && config.eventName === eventName) n += 1;
    } catch {
      // A trigger with unreadable config cannot be shown to reference this event.
    }
  }
  return n;
}
```

Column names are verified against `db.ts`: `automation_triggers` has `kind` and `config_json` (and `action_id` NOT NULL with a cascade FK, which the test's direct insert must satisfy).

- [ ] **Step 4: Run to verify it passes**

Run: `bun test src/server/apps.test.ts` and `bun run typecheck` — both green.

- [ ] **Step 5: Commit**

```bash
git add src/shared/api.ts src/server/apps.ts src/server/apps.test.ts
git commit -m "feat: AppEvent.dataKeys on the wire + recordDataKeys/countTriggersForEvent"
```

---

### Task 3: consumer auto-learn (best-effort, post-XACK)

**Files:**
- Modify: `src/server/redisInbound.ts` (`handleEntry`)
- Test: `src/server/redisInbound.test.ts` (extend)

**Interfaces:** Consumes `recordDataKeys` (Task 2).

**Context:** `handleEntry` (~178-199) decides → dispatches → `await c.xack(...)` (line ~188), with an outer catch that logs and re-XACKs. The learn goes AFTER the XACK, in its OWN try/catch so a learn failure never reaches the outer catch (which would log an entry error and XACK a second time).

- [ ] **Step 1: Write the failing test** — extend `src/server/redisInbound.test.ts`:

- A declared entry that dispatches records its keys (assert via `listAppEvents(...)[0].dataKeys`).
- A dropped entry (undeclared `type`) records nothing.
- A learn that THROWS does not stall the loop and does not double-XACK: inject a throwing `recordDataKeys` (via `mock.module` or a seam) and assert the entry is XACKed exactly once and `handleEntry` resolves.

- [ ] **Step 2: Run to verify it fails** — FAIL (no keys recorded).

- [ ] **Step 3: Implement** — in `handleEntry`, immediately after `await c.xack(key, GROUP, entryId);` inside the `try`:

```ts
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
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test src/server/redisInbound.test.ts` — PASS. Then `bun run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add src/server/redisInbound.ts src/server/redisInbound.test.ts
git commit -m "feat: inbound consumer auto-learns the data-key catalog"
```

---

### Task 4: `data.*` conditions — pure evaluator + server validation

**Files:**
- Modify: `src/server/triggerConditions.ts` (`fieldValue`)
- Modify: `src/server/automationTriggers.ts` (`normalizeConditions` field gate)
- Test: `src/server/triggerConditions.test.ts`, `src/server/automationTriggers.test.ts` (extend)

**Interfaces:** No signature changes. **The dispatcher is NOT modified** — `handleRedisEvent` already sets `context.data` (C1).

**Context:** `fieldValue(context, field)` is `(context as Record<string, unknown>)[field]` — a flat lookup, so `data.boss` reads `context['data.boss']` (undefined) instead of `context.data.boss`. `normalizeConditions` rejects any field not in `CONDITION_FIELDS[kind]` (line ~286); `CONDITION_FIELDS.redis_event` is `new Set(['actor','login'])` with a `// Conditions over {data.*} are C2` marker (~260).

- [ ] **Step 1: Write the failing test**

`src/server/triggerConditions.test.ts`:
```ts
test('a data.* field reads the nested payload', () => {
  const ctx = { data: { boss: 'Dragon', wave: 7 } } as unknown as TemplateContext;
  expect(evaluateConditions([{ field: 'data.boss', op: 'eq', value: 'dragon' }], ctx)).toBe(true);
  expect(evaluateConditions([{ field: 'data.wave', op: 'gte', value: 5 }], ctx)).toBe(true);
  expect(evaluateConditions([{ field: 'data.wave', op: 'gte', value: 9 }], ctx)).toBe(false);
});

test('a missing data key fails closed for every op including neq', () => {
  const ctx = { data: { boss: 'Dragon' } } as unknown as TemplateContext;
  expect(evaluateConditions([{ field: 'data.nope', op: 'neq', value: 'x' }], ctx)).toBe(false);
});

test('a data.* condition on a context with no data fails closed', () => {
  expect(evaluateConditions([{ field: 'data.boss', op: 'eq', value: 'x' }], {} as TemplateContext)).toBe(false);
});

test('a non-scalar data value compares as its JSON form, never [object Object]', () => {
  const ctx = { data: { loot: { rare: true } } } as unknown as TemplateContext;
  expect(evaluateConditions([{ field: 'data.loot', op: 'contains', value: 'rare' }], ctx)).toBe(true);
  expect(evaluateConditions([{ field: 'data.loot', op: 'contains', value: 'object' }], ctx)).toBe(false);
});
```

`src/server/automationTriggers.test.ts`: a `redis_event` trigger with a `data.wave gte 5` condition round-trips; a `data.` field with an illegal character (e.g. `data.a b`) is rejected 400; a `data.*` field on a NON-redis kind (e.g. `reward`) is still rejected 400.

- [ ] **Step 2: Run to verify it fails** — FAIL (flat lookup returns undefined; the field gate rejects `data.wave`).

- [ ] **Step 3: Implement**

`src/server/triggerConditions.ts` — replace `fieldValue`:

```ts
/** Inbound {data.*} keys live in a nested `data` object on the context, so a
 *  `data.<key>` condition field cannot be read by the flat property lookup every
 *  other field uses. A non-scalar coerces to the same JSON form {data.*} renders,
 *  so a condition and a template agree and `contains` never sees [object Object].
 *  A missing key stays `undefined`, preserving the fail-closed rule for every op. */
const DATA_FIELD_PATTERN = /^data\.(.+)$/;

function fieldValue(context: TemplateContext, field: string): unknown {
  const dataMatch = DATA_FIELD_PATTERN.exec(field);
  if (dataMatch) {
    const raw = context.data?.[dataMatch[1]!];
    if (raw === null || raw === undefined) return undefined;
    if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') return raw;
    try {
      return JSON.stringify(raw);
    } catch {
      return undefined;
    }
  }
  return (context as Record<string, unknown>)[field];
}
```

`src/server/automationTriggers.ts` — at the field gate (~286), allow pattern-matching `data.*` for `redis_event` only:

```ts
const DATA_CONDITION_FIELD = /^data\.[A-Za-z0-9_.-]+$/;
```
```ts
    // A redis_event trigger may also filter on any inbound {data.*} key. Validated by
    // PATTERN, never against the learned catalog: auto-learn lags a newly emitted key,
    // so gating on the catalog would reject a legitimate condition the app is about to
    // start sending. The catalog only drives the editor's picker.
    const isDataField = kind === 'redis_event' && DATA_CONDITION_FIELD.test(field);
    if (!isDataField && !CONDITION_FIELDS[kind]?.has(field)) {
      throw new HttpRouteError(400, `Field "${field}" is not available on a ${kind} trigger.`);
    }
```
Update the `// Conditions over {data.*} are C2` comment on `CONDITION_FIELDS.redis_event` to state that `data.*` is accepted by pattern alongside this set.

- [ ] **Step 4: Run to verify it passes**

Run: `bun test src/server/triggerConditions.test.ts src/server/automationTriggers.test.ts` — PASS. Then `bun run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add src/server/triggerConditions.ts src/server/automationTriggers.ts src/server/triggerConditions.test.ts src/server/automationTriggers.test.ts
git commit -m "feat: data.* condition fields (nested read + pattern-validated)"
```

---

### Task 5: conditions editor — `data.*` picker + type-aware ops

**Files:**
- Modify: `src/client/pages/settings/automation.ts` (`CONDITION_FIELDS_BY_KIND` comment, `conditionFieldsForKind`, `opsForField`, `validateConditions`, labels)
- Modify: `src/client/pages/settings/AutomationPage.tsx` (conditions rows for `redis_event`)
- Test: `src/client/pages/settings/automation.test.ts` (extend)

**Interfaces:** Consumes `AppEvent.dataKeys` (Task 2) and mirrors Task 4's server rules.

**Context (verified seams):** `CONDITION_FIELDS_BY_KIND.redis_event = ['actor','login']` (~209, with a C2 marker comment ~208); `NUMERIC_CONDITION_FIELDS = new Set(['amount','months'])` (~214); `conditionFieldsForKind(kind)` (~256); `opsForField(kind, field)` (~267); `validateConditions` rejects any field not in `CONDITION_FIELDS_BY_KIND[kind]` (~304) — which would reject every `data.*` field.

- [ ] **Step 1: Write the failing test** — extend `src/client/pages/settings/automation.test.ts`:

```ts
test('validateConditions accepts a data.* field on redis_event and rejects it elsewhere', () => {
  expect(validateConditions('redis_event', [{ field: 'data.wave', op: 'gte', value: 5 }])).toBeNull();
  expect(validateConditions('reward', [{ field: 'data.wave', op: 'gte', value: 5 }])).not.toBeNull();
});

test('validateConditions rejects a malformed data field', () => {
  expect(validateConditions('redis_event', [{ field: 'data.a b', op: 'eq', value: 'x' }])).not.toBeNull();
});

test('opsForField offers numeric ops for a number-typed data key and text ops otherwise', () => {
  expect(opsForField('redis_event', 'data.wave', 'number')).toEqual(['eq', 'neq', 'gte', 'lte', 'in']);
  expect(opsForField('redis_event', 'data.boss', 'string')).toEqual(['eq', 'neq', 'contains', 'starts_with', 'in']);
  expect(opsForField('redis_event', 'data.unknown')).toEqual(['eq', 'neq', 'contains', 'starts_with', 'in']);
});

test('conditionFieldsForKind appends catalog keys for redis_event', () => {
  expect(conditionFieldsForKind('redis_event', [{ name: 'boss', type: 'string' }])).toEqual(['actor', 'login', 'data.boss']);
  expect(conditionFieldsForKind('redis_event')).toEqual(['actor', 'login']);
});
```

- [ ] **Step 2: Run to verify it fails** — FAIL (extra args unsupported; `data.*` rejected).

- [ ] **Step 3: Implement**

- `conditionFieldsForKind(kind, dataKeys?: AppEventDataKey[])` — append `dataKeys.map(k => \`data.${k.name}\`)` when `kind === 'redis_event'`. Existing callers pass one arg and are unaffected.
- `opsForField(kind, field, dataKeyType?: AppEventDataKeyType)` — before the existing checks, if `field` starts with `data.`, return the numeric op set when `dataKeyType === 'number'`, else the comparison set. **Reuse the existing arrays; do not duplicate the op sets.**
- `validateConditions` — mirror the server: compute `const isDataField = kind === 'redis_event' && /^data\.[A-Za-z0-9_.-]+$/.test(field);` and skip the `CONDITION_FIELDS_BY_KIND` membership error when it is true. Everything else (op/value shape) is unchanged.
- Label a `data.*` field in the picker as the bare key name (e.g. `data.boss` → "Data: boss") via a small helper rather than adding entries to `CONDITION_FIELD_LABELS`.
- `AutomationPage.tsx` — the conditions rows for a `redis_event` draft pass the bound event's `dataKeys` into `conditionFieldsForKind`, and pass the selected key's type into `opsForField`. A key not in the catalog must remain usable (free-entry is preserved because validation is pattern-based).

- [ ] **Step 4: Run to verify it passes**

Run: `bun test src/client/pages/settings/automation.test.ts`, `bun run typecheck`, `bun run build` — all green.

- [ ] **Step 5: Commit**

```bash
git add src/client/pages/settings/automation.ts src/client/pages/settings/AutomationPage.tsx src/client/pages/settings/automation.test.ts
git commit -m "feat: data.* condition picker with type-aware ops"
```

---

### Task 6: lifecycle — computed inert flagging

**Files:**
- Modify: `src/client/pages/settings/automation.ts` (a pure `redisTriggerInertReason` helper)
- Modify: `src/client/pages/settings/AutomationPage.tsx` (render the badge)
- Test: `src/client/pages/settings/automation.test.ts` (extend)

**Interfaces:** Produces `redisTriggerInertReason(config, apps, events): string | null`.

**Context:** C1's consumer already drops an undeclared event and skips a disabled app, so an affected trigger is ALREADY inert at runtime — this task only surfaces it. Computed at load; nothing is persisted.

- [ ] **Step 1: Write the failing test**

```ts
test('redisTriggerInertReason flags a removed app, disabled app, and undeclared event', () => {
  const apps = [{ id: 'a1', name: 'pztmi', disabledAt: null }] as App[];
  const events = [{ appId: 'a1', eventName: 'boss_killed', dataKeys: [], createdAt: '' }] as AppEvent[];

  expect(redisTriggerInertReason({ appId: 'a1', eventName: 'boss_killed' }, apps, events)).toBeNull();
  expect(redisTriggerInertReason({ appId: 'gone', eventName: 'boss_killed' }, apps, events)).toMatch(/app/i);
  expect(redisTriggerInertReason({ appId: 'a1', eventName: 'not_declared' }, apps, events)).toMatch(/declared/i);
  const disabled = [{ id: 'a1', name: 'pztmi', disabledAt: '2026-07-24T00:00:00.000Z' }] as App[];
  expect(redisTriggerInertReason({ appId: 'a1', eventName: 'boss_killed' }, disabled, events)).toMatch(/disabled/i);
});
```

- [ ] **Step 2: Run to verify it fails** — FAIL (helper undefined).

- [ ] **Step 3: Implement** — a pure helper returning the first applicable reason (app missing → app disabled → event undeclared) or `null`; render it in `AutomationPage.tsx` as a warning badge on `redis_event` triggers in the list and in the editor. Copy states plainly that the trigger will not fire and why. Precedence order matters: a removed app is reported as removed, not as an undeclared event.

- [ ] **Step 4: Run to verify it passes**

Run: `bun test src/client/pages/settings/automation.test.ts`, `bun run typecheck`, `bun run build`.

- [ ] **Step 5: Commit**

```bash
git add src/client/pages/settings/automation.ts src/client/pages/settings/AutomationPage.tsx src/client/pages/settings/automation.test.ts
git commit -m "feat: flag redis_event triggers inert when their event or app is gone"
```

---

### Task 7: AppsPage remove hint + `{data.*}` reference

**Files:**
- Modify: `src/server/apps.ts` (expose the trigger count on the events route)
- Modify: `src/client/services/dashboard.ts` (if the response shape changes)
- Modify: `src/client/pages/settings/AppsPage.tsx` (the "N triggers reference this" hint)
- Modify: `src/client/pages/settings/AutomationPage.tsx` (advisory `{data.*}` key reference)
- Test: `src/server/apps.test.ts` (extend)

**Interfaces:** Consumes `countTriggersForEvent` (Task 2) and `AppEvent.dataKeys`.

- [ ] **Step 1: Write the failing test** — `apps.test.ts`: the events route returns each event's bound-trigger count; an event with no bound trigger reports 0.

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement**
- Add `boundTriggerCount: number` to the events GET response (either on `AppEvent` or a sibling field — choose ONE and update `shared/api.ts` + `dashboard.ts` consistently).
- `AppsPage.tsx`: next to each declared event's Remove control, show "N trigger(s) reference this" when the count is > 0. Removal stays **allowed** (non-blocking) — this is the "warn loudly" surface.
- `AutomationPage.tsx`: in the `redis_event` editor, render a read-only list of the bound event's `dataKeys` as `{data.<name>}` with its type, captioned as usable in the bound Actions' text steps. Empty catalog → a hint that keys appear after the app sends its first event. **Advisory only — do not validate Action templates against it** (Actions are shared across triggers and kinds).

- [ ] **Step 4: Run to verify it passes**

Run: `bun test src/server/apps.test.ts`, `bun run typecheck`, `bun run build`.

- [ ] **Step 5: Commit**

```bash
git add src/shared/api.ts src/server/apps.ts src/server/apps.test.ts src/client/services/dashboard.ts src/client/pages/settings/AppsPage.tsx src/client/pages/settings/AutomationPage.tsx
git commit -m "feat: de-registration trigger-count hint + {data.*} key reference"
```

---

## Final verification

- [ ] `bun run typecheck` · `bun test` · `bun run build` — all green.
- [ ] Manual (opt-in, real Redis + `STREAMER_TOOLS_CONSUME_INBOUND=1`): declare `boss_killed`; `XADD … v '{"type":"boss_killed","data":{"boss":"Dragon","wave":3}}'`; confirm `dataKeys` becomes `[{boss,string},{wave,number}]` and the conditions editor offers `data.boss`/`data.wave` with type-appropriate ops. Add `data.wave gte 5`: a `wave:3` event does not fire, a `wave:7` does. Remove the `boss_killed` declaration → the bound trigger shows an inert badge and stops firing; re-declare the NAME → the badge clears.

## Spec coverage self-check

| Spec section | Task |
|---|---|
| §2 contract (`AppEventDataKey`, `AppEvent.dataKeys`) | 1, 2 |
| §3 pure inference + merge core | 1 |
| §4 auto-learn wiring (best-effort, post-XACK) | 3 |
| §5 `data.*` conditions (evaluator + server validation) | 4 |
| §5 conditions editor (picker + type-aware ops) | 5 |
| §6 advisory `{data.*}` reference | 7 |
| §7 inert flagging + remove hint | 6, 7 |
| §8 schema (no column, no migration) | — (nothing to do) |
| §9 testing strategy | 1-7 |
