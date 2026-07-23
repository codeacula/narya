# Redis Phase A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Narya publishes its redeem / Twitch-event / module-switch events to a Redis stream (behind a fully-optional, `obs.ts`-style connection), rewards carry a `source` provenance tag validated against a names-only app registry, so an external app (PZTMI) can read the stream and react to its own source-tagged redeem.

**Architecture:** A new `redis.ts` owns one lazy `ioredis` connection modeled exactly on `obs.ts`; `eventBus.ts` builds a versioned, field-allowlisted envelope and publishes it fire-and-forget (never awaited on the redeem path). `apps.ts` is a names-only registry; `rewardProvenance.ts` maps `reward_id → source`. Three choke points (one per event family, each *after* the existing dedup/merge) call the bus. Health surfaces on `DashboardStatus`.

**Tech Stack:** Bun + TypeScript, Express, `bun:sqlite` (via `db.ts`), React (client), `bun test`, new dependency **`ioredis`**.

## Global Constraints

- **Fully optional:** no `redisUrl` configured → the whole layer is a no-op; the app boots and every existing path behaves exactly as today. (spec §1, §3.1)
- **A Redis hiccup must never break a redeem.** Every publish is `void`-ed + `.catch()`, never `await`-ed on the redeem/chat/module path. (spec §3.1)
- **`redisUrl` is a secret** — follows the `twitchClientSecret` pattern in `appConfig.ts` (stored column, `resolveSecret`, `clearRedisUrl` directive, `redisConfigured` boolean only in `toPublic`); never returned to the client, never logged raw, never on any overlay/`settings:updated` payload. (spec §4)
- **`.env` seeds nothing the Settings UI owns** — do NOT add an env read for `redisUrl`; the `DEFAULTS` literal in `appConfig.ts` is the sole fresh-install source. (CLAUDE.md)
- **New DB tables** are idempotent `create table if not exists` in `db.ts`; no `runOnce`, no `allowedMigration*` entries (those gate `addColumnIfMissing` on *existing* tables only). A new *column* on `app_config` DOES need an `allowedMigrationDefinitions` entry (lowercased) + an `addColumnIfMissing` call. (spec §; seam map)
- **Two-space indent; semicolons; `snake_case` columns aliased to `camelCase`; prepared statements at module top level.** Match existing files.
- **Verify per task:** `bun test <file>` for the task's test, and `bun run typecheck` before commit. Full `bun test` + `bun run build` at the end.

---

### Task 1: `redisUrl` secret config + `redis` AppConfigChange

**Files:**
- Modify: `src/server/db.ts` (allowlist entry + `addColumnIfMissing` call)
- Modify: `src/shared/api.ts` (`AppConfig`, `AppConfigUpdate`)
- Modify: `src/server/appConfig.ts` (DEFAULTS, internal type, row type, SQL, `loadRow`, accessor, `toPublic`, normalize, `saveAppConfig`, `AppConfigChange`, changes-Set)
- Modify: `src/server/index.ts` (`reconcileServices` stub branch)
- Test: `src/server/appConfig.test.ts`

**Interfaces:**
- Produces: `appConfig.redisUrl: string` (server-live accessor); `AppConfig.redisConfigured: boolean`; `AppConfigUpdate.redisUrl?: string` + `clearRedisUrl?: boolean`; `AppConfigChange` gains `'redis'`.

- [ ] **Step 1: Write the failing test** — append to `src/server/appConfig.test.ts`:

```ts
import { getAppConfig, saveAppConfig } from './appConfig'; // (already imported at top)

describe('redisUrl (secret)', () => {
  test('round-trips internally but is never returned to the client', () => {
    saveAppConfig({ redisUrl: 'redis://127.0.0.1:6379' });
    const pub = getAppConfig('');
    expect(pub.redisConfigured).toBe(true);
    expect((pub as Record<string, unknown>).redisUrl).toBeUndefined();
  });

  test('clearRedisUrl empties it', () => {
    saveAppConfig({ redisUrl: 'redis://127.0.0.1:6379' });
    expect(saveAppConfig({ clearRedisUrl: true }).config.redisConfigured).toBe(false);
  });

  test('a redisUrl change emits the redis AppConfigChange', () => {
    saveAppConfig({ clearRedisUrl: true });
    expect(saveAppConfig({ redisUrl: 'redis://localhost:6379' }).changes.has('redis')).toBe(true);
    expect(saveAppConfig({ redisUrl: 'redis://localhost:6379' }).changes.has('redis')).toBe(false);
  });

  test('rejects a non-redis scheme', () => {
    expect(() => saveAppConfig({ redisUrl: 'http://127.0.0.1:6379' })).toThrow(/redis:\/\/ or rediss:\/\//);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/server/appConfig.test.ts`
Expected: FAIL (`redisConfigured` undefined / `redisUrl` not accepted).

- [ ] **Step 3: Implement** — apply the config touch-list (each edit mirrors `twitchClientSecret`):

`src/server/db.ts` — add to `allowedMigrationDefinitions` (near the `tengwar_api_key` entry, lowercased) and to the `app_config` `addColumnIfMissing` group:
```ts
// in allowedMigrationDefinitions:
redis_url: "text not null default ''",
// beside the other app_config addColumnIfMissing calls:
addColumnIfMissing('app_config', 'redis_url', "text not null default ''");
```

`src/shared/api.ts` — `AppConfig` gains `redisConfigured: boolean;`; `AppConfigUpdate` gains `redisUrl?: string;` and `clearRedisUrl?: boolean;`.

`src/server/appConfig.ts`:
- `DEFAULTS`: `redisUrl: '',`
- `AppConfigInternal` and `AppConfigRow`: `redisUrl: string;`
- `selectRow` SQL: `redis_url as redisUrl,`
- `updateRow` SQL set-list: `redis_url = ?,` (and the matching `next.redisUrl,` arg in `updateRow.run(...)`, in the same position, before `updatedAt`)
- `loadRow()`: `redisUrl: row.redisUrl || '',`
- live accessor: `get redisUrl() { return current().redisUrl; },`
- `toPublic()`: `redisConfigured: Boolean(internal.redisUrl),`
- `NormalizedConfigUpdate`: add `redisUrl` to the `Omit<...>` secret list and add `redisUrl?: string;` + `clearRedisUrl: boolean;`
- `normalizeUpdate()` return: validate + normalize:
```ts
redisUrl: (() => {
  if (typeof value.redisUrl !== 'string') return undefined;
  const trimmed = value.redisUrl.trim();
  if (trimmed && !/^rediss?:\/\//.test(trimmed)) {
    throw new HttpRouteError(400, 'Redis URL must start with redis:// or rediss://');
  }
  return trimmed;
})(),
clearRedisUrl: value.clearRedisUrl === true,
```
  (Import `HttpRouteError` if not already imported, matching how the existing URL validation throws.)
- `saveAppConfig()` `next`: `redisUrl: resolveSecret(update.clearRedisUrl, update.redisUrl, prev.redisUrl),`
- `AppConfigChange`: add `| 'redis'`
- changes-Set: `if (next.redisUrl !== prev.redisUrl) changes.add('redis');`

`src/server/index.ts` — `reconcileServices`, add the branch (filled in Task 5):
```ts
if (changes.has('redis')) {
  reconcileRedis();
}
```
For now define a no-op `function reconcileRedis() {}` local stub so this task compiles; Task 5 replaces it.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/server/appConfig.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/db.ts src/shared/api.ts src/server/appConfig.ts src/server/index.ts src/server/appConfig.test.ts
git commit -m "feat: add redisUrl secret config + redis AppConfigChange"
```

---

### Task 2: names-only app registry (`apps` table + repo + routes)

**Files:**
- Modify: `src/server/db.ts` (new `apps` table in a `db.exec` group)
- Create: `src/server/apps.ts`
- Modify: `src/shared/api.ts` (`App`, `AppInput`)
- Modify: `src/server/index.ts` (`registerAppsRoutes(app)`)
- Test: `src/server/apps.test.ts`

**Interfaces:**
- Produces: `App = { id: string; name: string; createdAt: string; disabledAt: string | null }`; `listApps(): App[]`; `createApp(name: string): App`; `setAppDisabled(id: string, disabled: boolean): App | null`; `isKnownSource(source: string): boolean` (sentinels `narya`/`manual` OR any `apps` row, enabled or disabled); `listSelectableSources(): string[]` (sentinels + enabled apps). Routes: `GET/POST /api/apps`, `PATCH /api/apps/:id`.

- [ ] **Step 1: Write the failing test** — `src/server/apps.test.ts`:

```ts
import { beforeEach, describe, expect, test } from 'bun:test';
import { db } from './db';
import { createApp, isKnownSource, listApps, listSelectableSources, setAppDisabled } from './apps';

describe('apps registry', () => {
  beforeEach(() => { db.prepare('delete from apps').run(); });

  test('create + list', () => {
    const app = createApp('pztmi');
    expect(app.name).toBe('pztmi');
    expect(app.disabledAt).toBeNull();
    expect(listApps().map(a => a.name)).toEqual(['pztmi']);
  });

  test('duplicate name is rejected', () => {
    createApp('pztmi');
    expect(() => createApp('pztmi')).toThrow();
  });

  test('sentinels and registered apps are known sources; unknown is not', () => {
    createApp('pztmi');
    expect(isKnownSource('narya')).toBe(true);
    expect(isKnownSource('manual')).toBe(true);
    expect(isKnownSource('pztmi')).toBe(true);
    expect(isKnownSource('ghost')).toBe(false);
  });

  test('a disabled app stays a known source but drops out of selectable sources', () => {
    const app = createApp('pztmi');
    setAppDisabled(app.id, true);
    expect(isKnownSource('pztmi')).toBe(true);       // provenance rows stay valid
    expect(listSelectableSources()).toEqual(['narya', 'manual']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/server/apps.test.ts`
Expected: FAIL (`Cannot find module './apps'`).

- [ ] **Step 3: Implement**

`src/server/db.ts` — add inside a `db.exec` group (the automation-platform group is the natural home):
```ts
  create table if not exists apps (
    id text primary key,
    name text not null unique,
    created_at text not null,
    disabled_at text
  );
```

`src/shared/api.ts`:
```ts
export type App = { id: string; name: string; createdAt: string; disabledAt: string | null };
export type AppInput = { name: string };
```

`src/server/apps.ts`:
```ts
import type express from 'express';
import { db } from './db';
import { handle, HttpRouteError } from './http';
import type { App } from '../shared/api';

const RESERVED_SOURCES = new Set(['narya', 'manual']);

type AppRow = { id: string; name: string; createdAt: string; disabledAt: string | null };

const SELECT_COLUMNS = 'id, name, created_at as createdAt, disabled_at as disabledAt';
const listAppsRow = db.prepare(`select ${SELECT_COLUMNS} from apps order by name`);
const getAppRow = db.prepare(`select ${SELECT_COLUMNS} from apps where id = ?`);
const getAppByName = db.prepare('select 1 as present from apps where name = ?');
const insertApp = db.prepare('insert into apps (id, name, created_at, disabled_at) values (?, ?, ?, null)');
const setDisabled = db.prepare('update apps set disabled_at = ? where id = ?');

export function listApps(): App[] {
  return listAppsRow.all() as AppRow[];
}

function normalizeName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!/^[a-z0-9_-]{1,32}$/.test(name)) {
    throw new HttpRouteError(400, 'App name must be 1-32 chars of a-z, 0-9, _ or -.');
  }
  if (RESERVED_SOURCES.has(name)) throw new HttpRouteError(400, `"${name}" is a reserved source name.`);
  return name;
}

export function createApp(rawName: string): App {
  const name = normalizeName(rawName);
  if (getAppByName.get(name)) throw new HttpRouteError(409, `An app named "${name}" already exists.`);
  const id = crypto.randomUUID();
  insertApp.run(id, name, new Date().toISOString());
  return getAppRow.get(id) as App;
}

export function setAppDisabled(id: string, disabled: boolean): App | null {
  setDisabled.run(disabled ? new Date().toISOString() : null, id);
  return (getAppRow.get(id) as App | undefined) ?? null;
}

export function isKnownSource(source: string): boolean {
  if (RESERVED_SOURCES.has(source)) return true;
  return Boolean(getAppByName.get(source));
}

export function listSelectableSources(): string[] {
  const enabled = (listAppsRow.all() as AppRow[]).filter(a => !a.disabledAt).map(a => a.name);
  return ['narya', 'manual', ...enabled];
}

export function registerAppsRoutes(app: express.Express) {
  app.get('/api/apps', handle(async (_request, response) => {
    response.json(listApps());
  }));
  app.post('/api/apps', handle(async (request, response) => {
    const body = request.body as { name?: unknown };
    response.status(201).json(createApp(typeof body.name === 'string' ? body.name : ''));
  }));
  app.patch('/api/apps/:id', handle(async (request, response) => {
    const body = request.body as { disabled?: unknown };
    const updated = setAppDisabled(request.params.id, body.disabled === true);
    if (!updated) throw new HttpRouteError(404, 'App not found.');
    response.json(updated);
  }));
}
```

`src/server/index.ts` — import and register beside the other `registerXRoutes(app)` calls:
```ts
import { registerAppsRoutes } from './apps';
// ...
registerAppsRoutes(app);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/server/apps.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/db.ts src/server/apps.ts src/shared/api.ts src/server/index.ts src/server/apps.test.ts
git commit -m "feat: names-only app registry (apps table, repo, routes)"
```

---

### Task 3: reward provenance repo (`reward_provenance` table + repo)

**Files:**
- Modify: `src/server/db.ts` (new `reward_provenance` table)
- Create: `src/server/rewardProvenance.ts`
- Test: `src/server/rewardProvenance.test.ts`

**Interfaces:**
- Consumes: `isKnownSource` (Task 2).
- Produces: `getRewardSource(rewardId): string | null`; `setRewardSource(rewardId, source): void` (validates via `isKnownSource`, else 400); `clearRewardSource(rewardId): void`; `ensureManualProvenance(rewardId): void` (insert `source='manual'` only if no row).

- [ ] **Step 1: Write the failing test** — `src/server/rewardProvenance.test.ts`:

```ts
import { beforeEach, describe, expect, test } from 'bun:test';
import { db } from './db';
import { createApp } from './apps';
import { clearRewardSource, ensureManualProvenance, getRewardSource, setRewardSource } from './rewardProvenance';

describe('reward provenance', () => {
  beforeEach(() => {
    db.prepare('delete from reward_provenance').run();
    db.prepare('delete from apps').run();
  });

  test('join miss is null (never a fabricated manual)', () => {
    expect(getRewardSource('r1')).toBeNull();
  });

  test('setRewardSource validates against known sources', () => {
    expect(() => setRewardSource('r1', 'ghost')).toThrow();
    createApp('pztmi');
    setRewardSource('r1', 'pztmi');
    expect(getRewardSource('r1')).toBe('pztmi');
    setRewardSource('r1', 'manual'); // upsert overwrites
    expect(getRewardSource('r1')).toBe('manual');
  });

  test('ensureManualProvenance fills unknown ids but never overwrites an existing source', () => {
    createApp('pztmi');
    setRewardSource('r1', 'pztmi');
    ensureManualProvenance('r1');           // r1 already sourced -> unchanged
    ensureManualProvenance('r2');           // r2 unknown -> manual
    expect(getRewardSource('r1')).toBe('pztmi');
    expect(getRewardSource('r2')).toBe('manual');
  });

  test('clearRewardSource removes the row', () => {
    setRewardSource('r1', 'manual');
    clearRewardSource('r1');
    expect(getRewardSource('r1')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test src/server/rewardProvenance.test.ts`
Expected: FAIL (`Cannot find module './rewardProvenance'`).

- [ ] **Step 3: Implement**

`src/server/db.ts` — add beside the `apps` table:
```ts
  create table if not exists reward_provenance (
    reward_id text primary key,
    source text not null,
    external_ref text,
    created_at text not null
  );
```

`src/server/rewardProvenance.ts`:
```ts
import { db } from './db';
import { HttpRouteError } from './http';
import { isKnownSource } from './apps';

const getRow = db.prepare('select source from reward_provenance where reward_id = ?');
const upsert = db.prepare(`
  insert into reward_provenance (reward_id, source, external_ref, created_at)
  values (?, ?, ?, ?)
  on conflict(reward_id) do update set source = excluded.source
`);
const insertIfMissing = db.prepare(`
  insert into reward_provenance (reward_id, source, external_ref, created_at)
  values (?, 'manual', null, ?)
  on conflict(reward_id) do nothing
`);
const deleteRow = db.prepare('delete from reward_provenance where reward_id = ?');

export function getRewardSource(rewardId: string): string | null {
  const row = getRow.get(rewardId) as { source: string } | undefined;
  return row?.source ?? null;
}

export function setRewardSource(rewardId: string, source: string): void {
  if (!isKnownSource(source)) throw new HttpRouteError(400, `Unknown reward source "${source}".`);
  upsert.run(rewardId, source, null, new Date().toISOString());
}

/** Insert source='manual' for a reward id we have never seen. Never overwrites an existing source. */
export function ensureManualProvenance(rewardId: string): void {
  insertIfMissing.run(rewardId, new Date().toISOString());
}

export function clearRewardSource(rewardId: string): void {
  deleteRow.run(rewardId);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test src/server/rewardProvenance.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/db.ts src/server/rewardProvenance.ts src/server/rewardProvenance.test.ts
git commit -m "feat: reward_provenance table + repo (validated source, self-heal, clear)"
```

---

### Task 4: wire provenance into the rewards API

**Files:**
- Modify: `src/shared/api.ts` (`ViewerReward.source`, `ViewerRewardUpsert.source?`)
- Modify: `src/server/viewerRewards.ts` (payload `source`, self-heal in `fetchRewards`, POST write, DELETE clear, PATCH accepts `source`)
- Modify: `src/client/services/dashboard.ts` (no signature change — `updateViewerReward` already takes `Partial<ViewerRewardUpsert>`)
- Test: `src/server/viewerRewards.test.ts` (create if absent; else extend)

**Interfaces:**
- Consumes: `getRewardSource`, `ensureManualProvenance`, `setRewardSource`, `clearRewardSource` (Task 3).
- Produces: `ViewerReward.source: string | null` on every reward payload; `PATCH /api/twitch/rewards/:id` accepts `{ source }`.

- [ ] **Step 1: Write the failing test** — add to `src/server/viewerRewards.test.ts` (follow the file's existing fetch-stub + `RuntimeState` setup; if the file does not exist, model it on `src/server/twitch/api.test.ts`'s stub for `/helix/channel_points/custom_rewards`). Assert:

```ts
// GIVEN fetchRewards returns rewards r1 (unknown) and r2 (pre-tagged pztmi)
// THEN the payload carries source: r1 self-healed to 'manual', r2 stays 'pztmi'
test('fetchRewards self-heals unknown ids to manual and surfaces source', async () => {
  createApp('pztmi');
  setRewardSource('r2', 'pztmi');
  const rewards = await fetchRewards(fakeCredentials); // stub returns r1, r2
  const byId = Object.fromEntries(rewards.map(r => [r.id, r.source]));
  expect(byId['r1']).toBe('manual');
  expect(byId['r2']).toBe('pztmi');
});
```
(Use the module's real `fetchRewards` and its existing test credential/stub helpers.)

- [ ] **Step 2: Run to verify it fails**

Run: `bun test src/server/viewerRewards.test.ts`
Expected: FAIL (`source` undefined on the payload).

- [ ] **Step 3: Implement**

`src/shared/api.ts` — `ViewerReward` gains `source: string | null;`. `ViewerRewardUpsert` gains `source?: string;`.

`src/server/viewerRewards.ts`:
- Import: `import { clearRewardSource, ensureManualProvenance, getRewardSource, setRewardSource } from './rewardProvenance';`
- In `fetchRewards`, inside `allRewards.map(reward => {...})`: before building the object, `ensureManualProvenance(reward.id);` then add `source: getRewardSource(reward.id),` to the returned object. (Self-heal writes a `manual` row for dashboard/mobile-born rewards; `getRewardSource` then returns it.)
- In the POST handler, after `saveRewardCategory(created.id, reward.categoryId);` add: `setRewardSource(created.id, reward.source ?? 'narya');` (operator-created rewards default `narya`; a client may pass an app source).
- In the DELETE handler, after `clearRewardCategory.run(request.params.id);` add: `clearRewardSource(request.params.id);`
- In the PATCH handler (`updateViewerReward`), if `body.source` is a string, call `setRewardSource(request.params.id, body.source);` before returning `getRewardsResponse(state)`.

- [ ] **Step 4: Run to verify it passes**

Run: `bun test src/server/viewerRewards.test.ts`
Expected: PASS. Also run `bun run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add src/shared/api.ts src/server/viewerRewards.ts src/server/viewerRewards.test.ts
git commit -m "feat: reward provenance in the rewards API (source payload, self-heal, assign)"
```

---

### Task 5: `redis.ts` connection + `index.ts` wiring

**Files:**
- Modify: `package.json` (`bun add ioredis`)
- Create: `src/server/redis.ts`
- Modify: `src/server/index.ts` (import, `void startRedis()` in `server.listen` callback, replace the Task 1 `reconcileRedis` stub)
- Test: `src/server/redis.test.ts`

**Interfaces:**
- Consumes: `appConfig.redisUrl` (Task 1).
- Produces: `startRedis(): void`; `stopRedis(): void`; `isRedisConnected(): boolean`; `getRedisStatus(): { connected: boolean; lastError: string | null; lastPublishError: string | null }`; `redisPublish(key: string, minId: string, value: string): Promise<void>` (throws on failure, records `lastPublishError`); test seams `__setRedisClientFactory(f)`, `__resetRedisForTest()`.

- [ ] **Step 1: Add the dependency**

Run: `bun add ioredis`
Expected: `ioredis` appears in `package.json` dependencies and `bun.lock` updates.

- [ ] **Step 2: Write the failing test** — `src/server/redis.test.ts`:

```ts
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
```

- [ ] **Step 3: Run to verify it fails**

Run: `bun test src/server/redis.test.ts`
Expected: FAIL (`Cannot find module './redis'`).

- [ ] **Step 4: Implement** `src/server/redis.ts` (mirrors `obs.ts`):

```ts
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
```

`src/server/index.ts`:
- Replace the Task 1 local `reconcileRedis` stub — instead `import { reconcileRedis, startRedis } from './redis';` and delete the stub.
- In the `server.listen(...)` callback, beside `void connectObs();` add `startRedis();`.

- [ ] **Step 5: Run to verify it passes**

Run: `bun test src/server/redis.test.ts` then `bun run typecheck`
Expected: PASS + typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add package.json bun.lock src/server/redis.ts src/server/index.ts src/server/redis.test.ts
git commit -m "feat: redis.ts lazy connection (ioredis) + start/stop reconcile wiring"
```

---

### Task 6: `eventBus.ts` — envelope, allowlist, publish

**Files:**
- Modify: `src/shared/api.ts` (`NaryaEventEnvelope` + 3 data shapes)
- Create: `src/server/eventBus.ts`
- Test: `src/server/eventBus.test.ts`

**Interfaces:**
- Consumes: `redisPublish`, `getRedisStatus` (Task 5); `appConfig.redisUrl` (Task 1).
- Produces: `publishRedeem(input)`, `publishTwitchEvent(input)`, `publishModuleSwitch(input)` — all `void`, fire-and-forget; and pure `buildEnvelope(...)` for tests.

- [ ] **Step 1: Write the failing test** — `src/server/eventBus.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

const published: Array<{ key: string; value: string }> = [];
mock.module('./redis', () => ({
  redisPublish: async (key: string, _minId: string, value: string) => { published.push({ key, value }); },
  getRedisStatus: () => ({ connected: true, lastError: null, lastPublishError: null }),
}));

import { saveAppConfig } from './appConfig';
import { publishRedeem } from './eventBus';

function lastEnvelope() { return JSON.parse(published[published.length - 1].value); }

describe('event bus', () => {
  beforeEach(() => { published.length = 0; saveAppConfig({ redisUrl: 'redis://127.0.0.1:6379' }); });
  afterEach(() => { saveAppConfig({ clearRedisUrl: true }); });

  test('no redisUrl -> publish is a no-op (nothing sent)', async () => {
    saveAppConfig({ clearRedisUrl: true });
    publishRedeem({ sourceId: 'm1', channel: { id: 'b1', login: 'streamer' }, rewardId: 'r1', rewardTitle: 'Hydrate', rewardSource: 'pztmi', rewardExternalRef: null, redemptionId: 'x1', userId: 'u1', userLogin: 'viewer', userInput: 'go' });
    await Promise.resolve();
    expect(published).toHaveLength(0);
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

  test('a throwing redisPublish never escapes publishRedeem', async () => {
    mock.module('./redis', () => ({
      redisPublish: async () => { throw new Error('down'); },
      getRedisStatus: () => ({ connected: false, lastError: 'down', lastPublishError: 'down' }),
    }));
    const { publishRedeem: pr } = await import('./eventBus');
    expect(() => pr({ sourceId: 'm2', channel: { id: 'b1', login: 's' }, rewardId: 'r', rewardTitle: 't', rewardSource: null, rewardExternalRef: null, redemptionId: 'x', userId: 'u', userLogin: 'v', userInput: '' })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test src/server/eventBus.test.ts`
Expected: FAIL (`Cannot find module './eventBus'`).

- [ ] **Step 3: Implement**

`src/shared/api.ts`:
```ts
export type NaryaEventType = 'redeem' | 'twitch_event' | 'module_switch';
export type NaryaEventEnvelope = {
  version: 1;
  id: string;
  type: NaryaEventType;
  ts: string;
  channel: { id: string; login: string };
  source: 'narya';
  data: Record<string, unknown>;
};
```

`src/server/eventBus.ts`:
```ts
import { appConfig } from './appConfig';
import { redisPublish } from './redis';
import type { NaryaEventEnvelope, NaryaEventType } from '../shared/api';

const RETENTION_MS = 48 * 60 * 60 * 1000; // ~48h rolling window (MINID trim)
const STREAM_PREFIX = process.env['STREAMER_TOOLS_REDIS_PREFIX'] ?? process.env['NODE_ENV'] ?? 'dev';

function streamKey(): string { return `narya:${STREAM_PREFIX}:events`; }
function minId(now: number): string { return `${now - RETENTION_MS}-0`; }

type Channel = { id: string; login: string };

export function buildEnvelope(type: NaryaEventType, id: string, channel: Channel, data: Record<string, unknown>): NaryaEventEnvelope {
  return { version: 1, id, type, ts: new Date().toISOString(), channel, source: 'narya', data };
}

function publish(type: NaryaEventType, sourceId: string | null, channel: Channel, data: Record<string, unknown>): void {
  if (!appConfig.redisUrl) return; // fully-optional: no url -> true no-op
  const id = sourceId ?? crypto.randomUUID();
  const envelope = buildEnvelope(type, id, channel, data);
  const now = Date.now();
  // Fire-and-forget: NEVER awaited on the redeem/chat/module path. A throwing/hanging bus is swallowed.
  void redisPublish(streamKey(), minId(now), JSON.stringify(envelope))
    .catch((error) => { console.error('Redis publish failed:', error instanceof Error ? error.message : error); });
}

export function publishRedeem(input: {
  sourceId: string | null; channel: Channel;
  rewardId: string; rewardTitle: string; rewardSource: string | null; rewardExternalRef: string | null;
  redemptionId: string | null; userId: string; userLogin: string; userInput: string;
}): void {
  publish('redeem', input.sourceId, input.channel, {
    rewardId: input.rewardId, rewardTitle: input.rewardTitle,
    rewardSource: input.rewardSource, rewardExternalRef: input.rewardExternalRef,
    redemptionId: input.redemptionId, userId: input.userId, userLogin: input.userLogin, userInput: input.userInput,
  });
}

export function publishTwitchEvent(input: {
  sourceId: string | null; channel: Channel;
  eventKind: string; actorUserId: string; actorLogin: string; amount?: number; tier?: string;
}): void {
  publish('twitch_event', input.sourceId, input.channel, {
    eventKind: input.eventKind, actorUserId: input.actorUserId, actorLogin: input.actorLogin,
    amount: input.amount ?? null, tier: input.tier ?? null,
  });
}

export function publishModuleSwitch(input: {
  channel: Channel; fromModuleId: string | null; toModuleId: string | null; categoryId: string | null; categoryName: string | null;
}): void {
  publish('module_switch', null, input.channel, {
    fromModuleId: input.fromModuleId, toModuleId: input.toModuleId,
    categoryId: input.categoryId, categoryName: input.categoryName,
  });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test src/server/eventBus.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/api.ts src/server/eventBus.ts src/server/eventBus.test.ts
git commit -m "feat: eventBus.ts — versioned envelope, field allowlist, fire-and-forget publish"
```

---

### Task 7: choke points (redeem, Twitch events, module switch) + double-play guard

**Files:**
- Modify: `src/server/eventsub.ts` (redeem case + each Twitch-event case)
- Modify: `src/server/categoryModules.ts` (`applyOutcome` transition block, lazy import)
- Test: `src/server/eventBusChokePoints.test.ts`

**Interfaces:**
- Consumes: `publishRedeem`, `publishTwitchEvent`, `publishModuleSwitch` (Task 6).

- [ ] **Step 1: Write the failing test** — a `redeemOnce`-analogue asserting one publish per real event across the sub-merge. `src/server/eventBusChokePoints.test.ts`:

```ts
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const twitchCalls: Array<Record<string, unknown>> = [];
mock.module('./eventBus', () => ({
  publishRedeem: (i: Record<string, unknown>) => { twitchCalls.push({ kind: 'redeem', ...i }); },
  publishTwitchEvent: (i: Record<string, unknown>) => { twitchCalls.push({ kind: 'twitch', ...i }); },
  publishModuleSwitch: (i: Record<string, unknown>) => { twitchCalls.push({ kind: 'module', ...i }); },
}));

import { handleEventSubNotification } from './eventsub'; // confirm the exported entrypoint name/shape

describe('eventBus choke points', () => {
  beforeEach(() => { twitchCalls.length = 0; /* + reset any sub_merge_state table */ });

  test('a resub delivered as subscribe + subscription.message publishes exactly one twitch_event', async () => {
    const base = { broadcaster_user_id: 'b1', broadcaster_user_login: 's', user_name: 'V', user_login: 'v', tier: '1000' };
    await handleEventSubNotification('m1', 'channel.subscribe', { ...base });
    await handleEventSubNotification('m2', 'channel.subscription.message', { ...base, cumulative_months: 3 });
    expect(twitchCalls.filter(c => c.kind === 'twitch')).toHaveLength(1);
  });
});
```
(Adjust `handleEventSubNotification`'s real signature from `eventsub.ts:149`; the point is: drive the two halves of a resub through the real handler and assert ONE publish.)

- [ ] **Step 2: Run to verify it fails**

Run: `bun test src/server/eventBusChokePoints.test.ts`
Expected: FAIL (no publish yet, count 0 ≠ 1).

- [ ] **Step 3: Implement the choke points**

`src/server/eventsub.ts` — `import { publishRedeem, publishTwitchEvent } from './eventBus';`
- **Redeem** case (`channel.channel_points_custom_reward_redemption.add`): read the redemption id (`const redemptionId = typeof event.id === 'string' ? event.id : null;`) and, beside the `handleRewardRedemption({...})` dispatch, add:
```ts
publishRedeem({
  sourceId: messageId, channel: { id: String(event.broadcaster_user_id ?? ''), login: String(event.broadcaster_user_login ?? '') },
  rewardId: reward.id, rewardTitle: reward.title, rewardSource: getRewardSource(reward.id), rewardExternalRef: null,
  redemptionId, userId: String(event.user_id ?? ''), userLogin: loginOf(event) ?? '', userInput,
});
```
  Import `getRewardSource` from `./rewardProvenance`.
- **Each Twitch-event case** (`channel.follow`, `channel.subscribe`, `channel.subscription.message`, `channel.subscription.gift`, `channel.cheer`, `channel.raid`): beside each existing `handleTwitchEvent({ kind, ... })` call — and **only** there, never in the sub `pending && !pending.hasMessage` update-only branch — add the matching `publishTwitchEvent({ sourceId: messageId, channel: {...}, eventKind: '<kind>', actorUserId: String(event.user_id ?? event.from_broadcaster_user_id ?? ''), actorLogin: <the same loginOf(...) used by handleTwitchEvent>, amount: <event.total|event.bits|event.viewers|undefined>, tier: <tierLabel(...)|undefined> })`. This preserves the sub-merge single-publish invariant because the two sub sites are already mutually exclusive.

`src/server/categoryModules.ts` — inside `applyOutcome`'s `if (previousId !== nextId) { ... }` block, add a fire-and-forget publish using the **lazy import** idiom (to avoid the composition-root cycle), mirroring `fireModuleLifecycle`:
```ts
void (async () => {
  try {
    const { publishModuleSwitch } = await import('./eventBus');
    publishModuleSwitch({
      channel: { id: runtimeStateBroadcasterId(), login: getTwitchChannel() },
      fromModuleId: previousId, toModuleId: nextId, categoryId: gameId, categoryName: gameName,
    });
  } catch (error) { console.error('Redis module_switch publish failed:', error); }
})();
```
(If `categoryModules.ts` lacks a broadcaster-id accessor, pass `null` for `channel.id` — the coordinator does not hold `RuntimeState`; `getTwitchChannel()` supplies the login. Confirm and use `null` if no id is in scope.)

- [ ] **Step 4: Run to verify it passes**

Run: `bun test src/server/eventBusChokePoints.test.ts` then `bun run typecheck`
Expected: PASS + typecheck clean. Also run `bun test src/server/redeemOnce.test.ts` to confirm no regression.

- [ ] **Step 5: Commit**

```bash
git add src/server/eventsub.ts src/server/categoryModules.ts src/server/eventBusChokePoints.test.ts
git commit -m "feat: publish redeem/twitch/module-switch events at the post-dedup choke points"
```

---

### Task 8: health signal (`DashboardStatus` + toast)

**Files:**
- Modify: `src/shared/api.ts` (`DashboardStatus` += `redisConnected`, `lastPublishError`)
- Modify: `src/server/dashboard/status.ts` (`getDashboardStatusSnapshot`)
- Modify: `src/client/ui/serviceStatus.tsx` (transition toast)
- Test: `src/server/dashboard/status.test.ts` (extend if present; else assert the snapshot fields inline)

**Interfaces:**
- Consumes: `isRedisConnected`, `getRedisStatus` (Task 5).

- [ ] **Step 1: Write the failing test** — assert the snapshot carries the fields (model on the existing status test; if none, a minimal one):

```ts
import { getDashboardStatusSnapshot } from './status';
test('dashboard status reports redis health', () => {
  const snap = getDashboardStatusSnapshot(/* the existing test args */);
  expect(snap).toHaveProperty('redisConnected');
  expect(snap).toHaveProperty('lastPublishError');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test src/server/dashboard/status.test.ts`
Expected: FAIL (properties absent).

- [ ] **Step 3: Implement**

`src/shared/api.ts` — `DashboardStatus` gains `redisConnected: boolean;` and `lastPublishError: string | null;` (next to `eventSubError`).

`src/server/dashboard/status.ts` — in `getDashboardStatusSnapshot`'s returned object add (import from `../redis`):
```ts
redisConnected: isRedisConnected(),
lastPublishError: getRedisStatus().lastPublishError,
```

`src/client/ui/serviceStatus.tsx` — extend the `previous` ref shape to `{ obs, eventSub, redis }`, set `redis: status.redisConnected`, and add a transition block mirroring the OBS one:
```tsx
if (prev.redis && !status.redisConnected) {
  pushToast({ kind: 'error', title: 'Redis disconnected', message: status.lastPublishError ?? 'Check the Redis URL in Settings → Connections.' });
} else if (!prev.redis && status.redisConnected) {
  pushToast({ kind: 'success', title: 'Redis connected' });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test src/server/dashboard/status.test.ts` then `bun run typecheck`
Expected: PASS + typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/shared/api.ts src/server/dashboard/status.ts src/client/ui/serviceStatus.tsx src/server/dashboard/status.test.ts
git commit -m "feat: surface Redis connection health on DashboardStatus + a transition toast"
```

---

### Task 9: UI — reward source selector + Connections Redis field + registry section

**Files:**
- Modify: `src/client/pages/ViewerRewardsPage.tsx` (`RewardRow` source selector + handler + thread prop; source badge)
- Modify: `src/client/pages/settings/ConnectionsSection.tsx` (`redisUrl` field across `AppConfigForm`/mapper/empty/submit + JSX + inline alert)
- Modify: `src/client/services/dashboard.ts` (apps service fns; `updateViewerReward` already supports `source` via `Partial<ViewerRewardUpsert>`)
- Verify: `bun run typecheck`, `bun run build`, and a Chromium/CDP smoke.

**Interfaces:**
- Consumes: `ViewerReward.source` (Task 4), `App` + `/api/apps` (Task 2), `AppConfig.redisConfigured` (Task 1).

- [ ] **Step 1: Add the apps service + reward-source call** in `src/client/services/dashboard.ts`:
```ts
export const getApps = () => fetchJson<App[]>('/api/apps');
export const createApp = (name: string) => sendJson<App>('/api/apps', 'POST', { name });
export const setAppDisabled = (id: string, disabled: boolean) => sendJson<App>(`/api/apps/${id}`, 'PATCH', { disabled });
// updateViewerReward(id, { source }) already exists (Partial<ViewerRewardUpsert>)
```
(Import `App` from `../../shared/api`.)

- [ ] **Step 2: Reward source selector** — in `ViewerRewardsPage.tsx` `RewardRow`, beside the category `<select>`, add a source `<select>` populated from a `sources: string[]` prop (fetched from `getApps()` → `['narya','manual',...enabledAppNames]`), value `reward.source ?? ''`, `onChange` → a new `handleSourceChange(reward, value)` handler modeled exactly on `handleCategoryAssignment` but calling `updateViewerReward(reward.id, { source })`. Render `reward.source` as a small badge in the title line beside `Twitch-managed`. Thread the new prop through `renderGroup`.

- [ ] **Step 3: Connections Redis field** — in `ConnectionsSection.tsx` add `redisUrl` to `AppConfigForm`, `appConfigToForm`, `EMPTY_APP_CONFIG_FORM`, and the submit's `updateAppConfig({...})` list; add a text-input field (model on the OBS URL input) with placeholder `redis://127.0.0.1:6379`; add an inline `settings-alert--info` shown when `appConfigForm.redisConfigured` is false (optional Redis not configured) — copy the existing alert markup. (Redis is not password-split here; a single URL field carrying the secret is sufficient, and `redisConfigured` drives the "is it set" display since the URL never returns to the client.)

- [ ] **Step 4: Add an Apps registry section** (minimal) to Settings — a list of apps with an add-name input and a disable toggle, wired to `getApps`/`createApp`/`setAppDisabled`. Follow the existing settings-section list idiom (e.g. `StreamCategoriesPage`/`ContentSection`).

- [ ] **Step 5: Verify**

Run: `bun run typecheck && bun run build`
Expected: both clean. Then a Chromium/CDP smoke on a scratch DB (`STREAMER_TOOLS_DB=/tmp/scratch.sqlite bun run dev`): open Settings → Connections, confirm the Redis field + registry section render; on the Rewards page confirm the per-reward source selector renders and persists (network shows `PATCH /api/twitch/rewards/:id` with `{source}`).

- [ ] **Step 6: Commit**

```bash
git add src/client/pages/ViewerRewardsPage.tsx src/client/pages/settings/ConnectionsSection.tsx src/client/services/dashboard.ts
git commit -m "feat: reward source selector + Redis connection field + apps registry UI"
```

---

## Final verification

- [ ] `bun run typecheck` — clean
- [ ] `bun test` — all green (existing 1277 + the new suites)
- [ ] `bun run build` — clean
- [ ] Manual end-to-end (documented, needs a local Redis): configure `redisUrl`, register `pztmi`, tag a reward `source=pztmi`, redeem it, observe one `type=redeem` envelope with `rewardSource=pztmi` on `narya:<env>:events` via `XREAD`/a tiny listener. With `redisUrl` unset, confirm the full suite and a redeem behave exactly as before (no-op layer).

## Spec coverage self-check

| Spec section | Task |
|---|---|
| §3 Redis layer (obs.ts-style, survives down-at-boot, `enableOfflineQueue:false`) | 5 |
| §3.1 optionality + never-await-on-redeem | 5, 6 |
| §3.2 dev-safety env prefix | 6 |
| §4 secret config + `redisConfigured` + validation | 1 |
| §4.1 reconcile start/stop | 5 |
| §5 envelope + deterministic id + version | 6 |
| §5.1 per-type field allowlist | 6 |
| §5.2 MINID ~48h retention | 5, 6 |
| §6 choke points + double-play guard | 7 |
| §7 reward provenance (writes, self-heal, null-not-fabricated) | 3, 4 |
| §7.1 source-assignment UX | 9 |
| §8 names-only registry | 2 |
| §9 health signal | 8 |
| §10 contracts | 1, 4, 6, 8 |
| §11 testing (pure, ports/DI, double-play, no live Redis) | 1–8 |
