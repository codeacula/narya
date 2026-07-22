# Per-Viewer Trigger Overrides Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a specific viewer fires a trigger (resub, redeem, chat command), run a different Action than the trigger's usual one, with fallback to the usual Action when the special path can't deliver.

**Architecture:** A new `trigger_overrides` table maps `(trigger_id, login) → action_id`. The dispatcher's single `invoke()` choke point resolves the effective Action after the gates pass; a `skipped` override run falls back to the base Action under the same claimed run row. Triggers, dedup, cooldowns, and module scoping are untouched. Spec: `docs/superpowers/specs/2026-07-22-per-viewer-trigger-overrides-design.md`.

**Tech Stack:** Bun, TypeScript strict, Express, SQLite (`bun:sqlite`), React, `bun:test`.

## Global Constraints

- Two-space indentation, no linter — match surrounding style exactly.
- Shared contracts live in `src/shared/api.ts`; server and client import them, never redeclare.
- Server is the validation authority; client validation mirrors it (first-problem-string-or-null pattern).
- A `skipped` Action run broadcasts nothing — the fallback leans on this invariant; never weaken it.
- No WebSocket changes, nothing added to `OVERLAY_EVENTS`.
- Logins are stored trimmed, `@`-stripped, lowercased, matching `/^[a-z0-9_]{1,25}$/`.
- Per task, run that task's test file (`bun test src/server/<file>.test.ts`); the full `bun test` + `bun run typecheck` + `bun run build` happen in Task 7. (~21 media-asset tests fail only in git worktrees where `public/` is absent — pre-existing, not a regression.)
- Commit after each task with a semantic message ending in `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- One deliberate deviation from the spec's route sketch: a single `GET /api/automation/overrides` (list all) replaces per-trigger GETs — the settings page needs every trigger's override count in one fetch. `PUT /api/automation/triggers/:id/overrides` and `DELETE /api/automation/overrides/:id` are as specced.

---

### Task 1: `trigger_overrides` schema + self-healing guard

**Files:**
- Modify: `src/server/db.ts` (DDL block ending ~line 491, index block ~line 493-502, guard near `dropStaleLlmInteractions` ~line 62-78)
- Test: `src/server/dbTriggerOverridesMigration.test.ts` (create)

**Interfaces:**
- Produces: table `trigger_overrides(id, trigger_id, login, action_id, enabled, note, created_at, updated_at)` with `unique (trigger_id, login)` and FK cascades; exported `dropStaleTriggerOverrides(database: Database): boolean`.

- [ ] **Step 1: Write the failing test**

Create `src/server/dbTriggerOverridesMigration.test.ts`, mirroring `dbLlmMigration.test.ts`:

```ts
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { dropStaleTriggerOverrides } from './db';

/** A plausible mid-edit shape the operator's bun --watch could have persisted. */
const STALE_SCHEMA = `
  create table trigger_overrides (
    id text primary key,
    trigger_id text not null,
    login text not null
  );
`;

const SHIPPED_SCHEMA = `
  create table trigger_overrides (
    id text primary key,
    trigger_id text not null,
    login text not null,
    action_id text not null,
    enabled integer not null default 1,
    note text not null default '',
    created_at text not null,
    updated_at text not null,
    unique (trigger_id, login)
  );
`;

function columnNames(database: Database): string[] {
  return (database.prepare("PRAGMA table_info('trigger_overrides')").all() as Array<{ name: string }>)
    .map(column => column.name);
}

test('a stale-shaped table is dropped so the shipped DDL can recreate it', () => {
  const database = new Database(':memory:');
  database.exec(STALE_SCHEMA);

  expect(dropStaleTriggerOverrides(database)).toBe(true);
  expect(columnNames(database)).toEqual([]);
});

test('the shipped shape is left untouched, rows intact', () => {
  const database = new Database(':memory:');
  database.exec(SHIPPED_SCHEMA);
  database.exec(`
    insert into trigger_overrides (id, trigger_id, login, action_id, enabled, note, created_at, updated_at)
    values ('o1', 't1', 'sorlus', 'a1', 1, '', '2026-07-22T00:00:00.000Z', '2026-07-22T00:00:00.000Z')
  `);

  expect(dropStaleTriggerOverrides(database)).toBe(false);
  expect(columnNames(database)).toContain('action_id');
  expect(database.prepare('select count(*) as n from trigger_overrides').get()).toEqual({ n: 1 });
});

test('an absent table is a no-op', () => {
  expect(dropStaleTriggerOverrides(new Database(':memory:'))).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/server/dbTriggerOverridesMigration.test.ts`
Expected: FAIL — `dropStaleTriggerOverrides` is not exported from `./db`.

- [ ] **Step 3: Implement**

In `src/server/db.ts`, directly below `dropStaleLlmInteractions` (after line 69), add:

```ts
/**
 * trigger_overrides is operator config, but it is cheap to re-enter and a boot crash
 * is worse: the operator's `bun --watch` executes and persists any mid-edit DDL shape
 * into the real database, and `create table if not exists` never heals it. If the
 * column set is not the shipped shape, drop the table so the DDL below recreates it.
 */
const TRIGGER_OVERRIDE_COLUMNS_SHIPPED = [
  'id', 'trigger_id', 'login', 'action_id', 'enabled', 'note', 'created_at', 'updated_at',
];

export function dropStaleTriggerOverrides(database: Database): boolean {
  const columns = database.prepare("PRAGMA table_info('trigger_overrides')").all() as Array<{ name: string }>;
  if (columns.length === 0) return false;
  const names = columns.map(column => column.name).sort();
  const shipped = [...TRIGGER_OVERRIDE_COLUMNS_SHIPPED].sort();
  if (names.length === shipped.length && names.every((name, index) => name === shipped[index])) return false;
  database.exec('drop table trigger_overrides');
  return true;
}
```

On the line after `dropStaleLlmInteractions(db);` (line 78), add:

```ts
dropStaleTriggerOverrides(db);
```

In the schema `db.exec` block, immediately after the `automation_runs` table (before the closing backtick at ~line 491), add:

```sql
  -- Per-viewer Action substitution: when trigger_id fires for login, run action_id
  -- instead of the trigger's own Action. See triggerOverrides.ts and the design spec.
  create table if not exists trigger_overrides (
    id text primary key,
    trigger_id text not null,
    login text not null,                -- lowercased, trimmed, '@'-stripped Twitch login
    action_id text not null,
    enabled integer not null default 1,
    note text not null default '',
    created_at text not null,
    updated_at text not null,
    unique (trigger_id, login),
    foreign key (trigger_id) references automation_triggers(id) on delete cascade,
    foreign key (action_id) references actions(id) on delete cascade
  );
```

In the index `db.exec` block (~line 493-502), after `idx_automation_triggers_module`, add:

```sql
  create index if not exists idx_trigger_overrides_login on trigger_overrides(login);
```

Note: `Database` is already imported in db.ts (it constructs `new Database(dbPath)`); if the type-only import differs, match how `dropStaleLlmInteractions` types its parameter.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/server/dbTriggerOverridesMigration.test.ts`
Expected: PASS (3 tests). Also run `bun test src/server/db.test.ts` — expected PASS (no schema regressions).

- [ ] **Step 5: Commit**

```bash
git add src/server/db.ts src/server/dbTriggerOverridesMigration.test.ts
git commit -m "feat: add trigger_overrides table with watch-server self-healing guard"
```

---

### Task 2: Contracts + `triggerOverrides.ts` repo, validation, and routes

**Files:**
- Modify: `src/shared/api.ts` (after `AutomationTriggerInput`, ~line 1154)
- Create: `src/server/triggerOverrides.ts`
- Modify: `src/server/index.ts` (route registration, after line 139)
- Test: `src/server/triggerOverrides.test.ts` (create)

**Interfaces:**
- Consumes: `trigger_overrides` table (Task 1); `handle`/`HttpRouteError` from `./http`; `db` from `./db`.
- Produces (later tasks rely on these exact signatures):
  - `TriggerOverride` / `TriggerOverrideInput` types in `src/shared/api.ts`
  - `resolveOverrideActionId(triggerId: string, login: string): string | null`
  - `listTriggerOverrides(): TriggerOverride[]`
  - `upsertTriggerOverride(triggerId: string, body: unknown): TriggerOverride`
  - `deleteTriggerOverride(id: string): void`
  - `deleteOverridesForLogin(login: string): number`
  - `registerTriggerOverrideRoutes(app: express.Express): void`
  - Routes: `GET /api/automation/overrides`, `PUT /api/automation/triggers/:id/overrides`, `DELETE /api/automation/overrides/:id`

- [ ] **Step 1: Add the shared contracts**

In `src/shared/api.ts`, directly after the `AutomationTriggerInput` line (~1154), add:

```ts
/**
 * Per-viewer Action substitution on one trigger: when `triggerId` fires for `login`,
 * run `actionId` instead of the trigger's own Action. The base trigger still matches,
 * claims its one dedupe key, and owns the cooldowns — the override only decides which
 * Action that single invocation runs, so a double alert is structurally impossible.
 */
export type TriggerOverride = {
  id: string;
  triggerId: string;
  login: string;
  actionId: string;
  enabled: boolean;
  note: string;
  createdAt: string;
  updatedAt: string;
};

// triggerId comes from the route path, so the body cannot disagree with it.
export type TriggerOverrideInput = Omit<TriggerOverride, 'id' | 'triggerId' | 'createdAt' | 'updatedAt'>;
```

- [ ] **Step 2: Write the failing tests**

Create `src/server/triggerOverrides.test.ts`:

```ts
import { beforeEach, describe, expect, test } from 'bun:test';
import { createAction } from './actions';
import { createAutomationTrigger } from './automationTriggers';
import { db } from './db';
import {
  deleteOverridesForLogin,
  deleteTriggerOverride,
  listTriggerOverrides,
  resolveOverrideActionId,
  upsertTriggerOverride,
} from './triggerOverrides';

let baseActionId = '';
let specialActionId = '';
let triggerId = '';

beforeEach(() => {
  db.exec('delete from trigger_overrides');
  db.exec('delete from automation_runs');
  db.exec('delete from automation_triggers');
  db.exec('delete from action_steps');
  db.exec('delete from actions');
  db.exec('delete from ignored_logins');

  baseActionId = createAction({
    name: 'Base alert', description: '', enabled: true,
    steps: [{ type: 'send_chat', enabled: true, delayMs: 0, payload: { template: 'hi {actor}', sender: 'bot' } }],
  }).id;
  specialActionId = createAction({
    name: 'Special alert', description: '', enabled: true,
    steps: [{ type: 'send_chat', enabled: true, delayMs: 0, payload: { template: 'HI {actor}!!', sender: 'bot' } }],
  }).id;
  triggerId = createAutomationTrigger({
    kind: 'twitch_event', actionId: baseActionId, moduleId: null, enabled: true,
    globalCooldownMs: 0, userCooldownMs: 0, config: { eventKind: 'sub' },
  }).id;
});

describe('upsertTriggerOverride', () => {
  test('creates, normalizes the login, and reads back', () => {
    const saved = upsertTriggerOverride(triggerId, { login: '@Sorlus', actionId: specialActionId, enabled: true, note: '' });

    expect(saved.login).toBe('sorlus');
    expect(saved.triggerId).toBe(triggerId);
    expect(saved.actionId).toBe(specialActionId);
    expect(listTriggerOverrides()).toHaveLength(1);
  });

  test('same login upserts in place — the unique constraint is not a 500', () => {
    upsertTriggerOverride(triggerId, { login: 'sorlus', actionId: specialActionId, enabled: true, note: '' });
    const second = upsertTriggerOverride(triggerId, { login: 'SORLUS', actionId: baseActionId, enabled: false, note: 'off for now' });

    expect(listTriggerOverrides()).toHaveLength(1);
    expect(second.actionId).toBe(baseActionId);
    expect(second.enabled).toBe(false);
    expect(second.note).toBe('off for now');
  });

  test('rejects a bad login, a missing action, an unknown trigger, and a non-actor kind', () => {
    expect(() => upsertTriggerOverride(triggerId, { login: 'has spaces', actionId: specialActionId, enabled: true, note: '' })).toThrow();
    expect(() => upsertTriggerOverride(triggerId, { login: 'sorlus', actionId: 'nope', enabled: true, note: '' })).toThrow();
    expect(() => upsertTriggerOverride('nope', { login: 'sorlus', actionId: specialActionId, enabled: true, note: '' })).toThrow();

    const manual = createAutomationTrigger({
      kind: 'manual', actionId: baseActionId, moduleId: null, enabled: true,
      globalCooldownMs: 0, userCooldownMs: 0, config: { label: 'Button' },
    });
    expect(() => upsertTriggerOverride(manual.id, { login: 'sorlus', actionId: specialActionId, enabled: true, note: '' })).toThrow();
  });

  test('rejects a flushed (ignored) login', () => {
    db.prepare('insert into ignored_logins (login, reason, created_at) values (?, ?, ?)')
      .run('spambot', '', new Date().toISOString());
    expect(() => upsertTriggerOverride(triggerId, { login: 'spambot', actionId: specialActionId, enabled: true, note: '' })).toThrow();
  });
});

describe('resolveOverrideActionId', () => {
  test('resolves an enabled override whose action is enabled', () => {
    upsertTriggerOverride(triggerId, { login: 'sorlus', actionId: specialActionId, enabled: true, note: '' });
    expect(resolveOverrideActionId(triggerId, 'sorlus')).toBe(specialActionId);
  });

  test('returns null for other viewers, empty logins, disabled overrides, and disabled actions', () => {
    upsertTriggerOverride(triggerId, { login: 'sorlus', actionId: specialActionId, enabled: true, note: '' });
    expect(resolveOverrideActionId(triggerId, 'someoneelse')).toBeNull();
    expect(resolveOverrideActionId(triggerId, '')).toBeNull();

    upsertTriggerOverride(triggerId, { login: 'sorlus', actionId: specialActionId, enabled: false, note: '' });
    expect(resolveOverrideActionId(triggerId, 'sorlus')).toBeNull();

    upsertTriggerOverride(triggerId, { login: 'sorlus', actionId: specialActionId, enabled: true, note: '' });
    db.prepare('update actions set enabled = 0 where id = ?').run(specialActionId);
    expect(resolveOverrideActionId(triggerId, 'sorlus')).toBeNull();
  });
});

describe('cascades and deletion', () => {
  test('deleting the trigger removes its overrides; deleting the override action removes the override', () => {
    upsertTriggerOverride(triggerId, { login: 'sorlus', actionId: specialActionId, enabled: true, note: '' });
    db.prepare('delete from actions where id = ?').run(specialActionId);
    expect(listTriggerOverrides()).toHaveLength(0);

    upsertTriggerOverride(triggerId, { login: 'sorlus', actionId: baseActionId, enabled: true, note: '' });
    db.prepare('delete from automation_triggers where id = ?').run(triggerId);
    expect(listTriggerOverrides()).toHaveLength(0);
  });

  test('deleteTriggerOverride removes one; unknown id is a 404', () => {
    const saved = upsertTriggerOverride(triggerId, { login: 'sorlus', actionId: specialActionId, enabled: true, note: '' });
    deleteTriggerOverride(saved.id);
    expect(listTriggerOverrides()).toHaveLength(0);
    expect(() => deleteTriggerOverride(saved.id)).toThrow();
  });

  test('deleteOverridesForLogin reports the count', () => {
    upsertTriggerOverride(triggerId, { login: 'sorlus', actionId: specialActionId, enabled: true, note: '' });
    expect(deleteOverridesForLogin('sorlus')).toBe(1);
    expect(deleteOverridesForLogin('sorlus')).toBe(0);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test src/server/triggerOverrides.test.ts`
Expected: FAIL — module `./triggerOverrides` does not exist.

- [ ] **Step 4: Implement `src/server/triggerOverrides.ts`**

```ts
import type express from 'express';
import type { TriggerOverride } from '../shared/api';
import { db } from './db';
import { handle, HttpRouteError } from './http';

/**
 * Per-viewer Action substitution. The dispatcher calls resolveOverrideActionId at its
 * invoke() choke point; everything else here is the operator-facing CRUD.
 *
 * Leaf module over db.ts on purpose: both triggerDispatcher.ts and viewerIdentity.ts
 * import it, and neither may drag route or dispatcher machinery in with it.
 */

const MAX_NOTE_LENGTH = 200;
const LOGIN_PATTERN = /^[a-z0-9_]{1,25}$/;

/** Kinds where a real viewer arrives on the signal. */
const OVERRIDABLE_TRIGGER_KINDS = new Set(['reward', 'twitch_event', 'chat_phrase', 'viewer_command']);

type OverrideRow = {
  id: string;
  triggerId: string;
  login: string;
  actionId: string;
  enabled: number;
  note: string;
  createdAt: string;
  updatedAt: string;
};

const OVERRIDE_COLUMNS = `
  id,
  trigger_id as triggerId,
  login,
  action_id as actionId,
  enabled,
  note,
  created_at as createdAt,
  updated_at as updatedAt
`;

const listRows = db.prepare(`select ${OVERRIDE_COLUMNS} from trigger_overrides order by created_at asc`);
const getRowById = db.prepare(`select ${OVERRIDE_COLUMNS} from trigger_overrides where id = ?`);
const getRowByTriggerAndLogin = db.prepare(`select ${OVERRIDE_COLUMNS} from trigger_overrides where trigger_id = ? and login = ?`);
// The join IS the pre-flight fallback: a disabled override or a disabled/deleted
// override Action resolves to nothing, and the trigger's own Action runs.
const resolveRow = db.prepare(`
  select o.action_id as actionId from trigger_overrides o
  join actions a on a.id = o.action_id
  where o.trigger_id = ? and o.login = ? and o.enabled = 1 and a.enabled = 1
`);
// on conflict, not check-then-insert: two concurrent saves must not race the
// unique (trigger_id, login) constraint into a 500.
const upsertRow = db.prepare(`
  insert into trigger_overrides (id, trigger_id, login, action_id, enabled, note, created_at, updated_at)
  values (?, ?, ?, ?, ?, ?, ?, ?)
  on conflict (trigger_id, login) do update set
    action_id = excluded.action_id,
    enabled = excluded.enabled,
    note = excluded.note,
    updated_at = excluded.updated_at
`);
const deleteRowById = db.prepare('delete from trigger_overrides where id = ?');
const deleteRowsForLogin = db.prepare('delete from trigger_overrides where login = ?');
const triggerKindById = db.prepare('select kind from automation_triggers where id = ?');
const actionById = db.prepare('select 1 as present from actions where id = ?');
const ignoredByLogin = db.prepare('select 1 as present from ignored_logins where login = ?');

function rowToOverride(row: OverrideRow): TriggerOverride {
  return {
    id: row.id,
    triggerId: row.triggerId,
    login: row.login,
    actionId: row.actionId,
    enabled: row.enabled === 1,
    note: row.note,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function normalizeOverrideLogin(value: unknown): string {
  const login = typeof value === 'string' ? value.trim().replace(/^@+/, '').toLowerCase() : '';
  if (!LOGIN_PATTERN.test(login)) {
    throw new HttpRouteError(400, 'Overrides need a Twitch login: letters, numbers, or underscores.');
  }
  return login;
}

export function listTriggerOverrides(): TriggerOverride[] {
  return (listRows.all() as OverrideRow[]).map(rowToOverride);
}

/** The dispatcher's point query. Empty login (anonymous gift/cheer) never matches. */
export function resolveOverrideActionId(triggerId: string, login: string): string | null {
  if (!login) return null;
  const row = resolveRow.get(triggerId, login) as { actionId: string } | null;
  return row?.actionId ?? null;
}

export function upsertTriggerOverride(triggerId: string, body: unknown): TriggerOverride {
  const value = body && typeof body === 'object' ? body as Record<string, unknown> : {};

  const trigger = triggerKindById.get(triggerId) as { kind: string } | null;
  if (!trigger) throw new HttpRouteError(404, 'Trigger not found.');
  if (!OVERRIDABLE_TRIGGER_KINDS.has(trigger.kind)) {
    throw new HttpRouteError(400, 'Only reward, Twitch event, chat phrase, and viewer command triggers carry a viewer to override on.');
  }

  const login = normalizeOverrideLogin(value.login);
  // A flushed viewer must stay flushed: an override row would silently reintroduce
  // the login into operator config, which is exactly what the ignore list prevents.
  if (ignoredByLogin.get(login)) {
    throw new HttpRouteError(400, `${login} is on the ignored list. Unflush them first.`);
  }

  const actionId = typeof value.actionId === 'string' ? value.actionId.trim() : '';
  if (!actionId || !actionById.get(actionId)) throw new HttpRouteError(400, 'Action not found.');

  const enabled = typeof value.enabled === 'boolean' ? value.enabled : true;
  const note = typeof value.note === 'string' ? value.note.slice(0, MAX_NOTE_LENGTH) : '';

  const now = new Date().toISOString();
  upsertRow.run(crypto.randomUUID(), triggerId, login, actionId, enabled ? 1 : 0, note, now, now);

  const saved = getRowByTriggerAndLogin.get(triggerId, login) as OverrideRow | null;
  if (!saved) throw new HttpRouteError(500, 'Override was not saved.');
  return rowToOverride(saved);
}

export function deleteTriggerOverride(id: string): void {
  if (!getRowById.get(id)) throw new HttpRouteError(404, 'Override not found.');
  deleteRowById.run(id);
}

/** Called from flushViewer's transaction. Returns the number removed, for the flush report. */
export function deleteOverridesForLogin(login: string): number {
  return (deleteRowsForLogin.run(login.trim().toLowerCase()) as { changes: number }).changes;
}

/** Operator-only: requireDashboardToken already gates /api. */
export function registerTriggerOverrideRoutes(app: express.Express) {
  app.get('/api/automation/overrides', (_request, response) => {
    response.json(listTriggerOverrides());
  });

  app.put('/api/automation/triggers/:id/overrides', handle((request, response) => {
    response.json(upsertTriggerOverride(request.params.id, request.body));
  }));

  app.delete('/api/automation/overrides/:id', handle((request, response) => {
    deleteTriggerOverride(request.params.id);
    response.status(204).end();
  }));
}
```

- [ ] **Step 5: Register the routes**

In `src/server/index.ts`: add `import { registerTriggerOverrideRoutes } from './triggerOverrides';` alongside the other imports (keep alphabetical-ish grouping with line 5's automationTriggers import), and after line 139 (`registerAutomationTriggerRoutes(app, getTriggerDispatcher());`) add:

```ts
registerTriggerOverrideRoutes(app);
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test src/server/triggerOverrides.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 7: Commit**

```bash
git add src/shared/api.ts src/server/triggerOverrides.ts src/server/index.ts src/server/triggerOverrides.test.ts
git commit -m "feat: trigger override contracts, repository, and routes"
```

---

### Task 3: Dispatcher substitution + skip-fallback

**Files:**
- Modify: `src/server/triggerDispatcher.ts` (imports ~line 16; `invoke()` body, lines 248-263)
- Test: `src/server/triggerDispatcher.test.ts` (extend)

**Interfaces:**
- Consumes: `resolveOverrideActionId(triggerId, login)` from Task 2.
- Produces: `invoke()` runs the override's Action when one resolves; a `skipped` override run falls back to `trigger.actionId` under the same run row with detail prefixed `Override for <login> skipped; ran the base action.`; `TriggerRunSummary.actionId` reports the Action that produced the final result. No signature changes.

- [ ] **Step 1: Write the failing tests**

Append to `src/server/triggerDispatcher.test.ts` (reuse the file's existing `setup`, `trigger`, and `actionId` helpers; `createAction` is already imported). Also add the import at the top of the file:

```ts
import { upsertTriggerOverride } from './triggerOverrides';
```

Add `db.exec('delete from trigger_overrides');` to the existing `beforeEach` (with the other deletes — it must run before `delete from automation_triggers` is NOT required since cascades handle it, but explicit is consistent; place it first in the list).

```ts
describe('per-viewer trigger overrides', () => {
  function specialAction(name = 'Special action') {
    return createAction({
      name, description: '', enabled: true,
      steps: [{ type: 'send_chat', enabled: true, delayMs: 0, payload: { template: 'special', sender: 'bot' } }],
    }).id;
  }

  test('the override action runs instead of the base — never both', async () => {
    const specialId = specialAction();
    const created = trigger({ kind: 'twitch_event', config: { eventKind: 'sub' } });
    upsertTriggerOverride(created.id, { login: 'sorlus', actionId: specialId, enabled: true, note: '' });
    const { dispatcher, runner } = setup();

    const runs = await dispatcher.handleTwitchEvent({ kind: 'sub', eventId: 'evt-1', actor: 'Sorlus', login: 'sorlus' });

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]!.actionId).toBe(specialId);
    expect(runs[0]!.actionId).toBe(specialId);
  });

  test('other viewers and anonymous events take the base action', async () => {
    const specialId = specialAction();
    const created = trigger({ kind: 'twitch_event', config: { eventKind: 'sub' } });
    upsertTriggerOverride(created.id, { login: 'sorlus', actionId: specialId, enabled: true, note: '' });
    const { dispatcher, runner } = setup();

    await dispatcher.handleTwitchEvent({ kind: 'sub', eventId: 'evt-2', actor: 'Frodo', login: 'frodo' });
    await dispatcher.handleTwitchEvent({ kind: 'gift', eventId: 'evt-3', actor: 'Anonymous', login: null });

    expect(runner.calls).toHaveLength(1); // the gift matched no trigger; the sub ran base
    expect(runner.calls[0]!.actionId).toBe(actionId);
  });

  test('a skipped override run falls back to the base action, once, same run row', async () => {
    const specialId = specialAction();
    const created = trigger({ kind: 'twitch_event', config: { eventKind: 'sub' } });
    upsertTriggerOverride(created.id, { login: 'sorlus', actionId: specialId, enabled: true, note: '' });

    const calls: Array<{ actionId: string }> = [];
    const { dispatcher } = setup({
      runAction: async (id: string) => {
        calls.push({ actionId: id });
        // The special path's media is unavailable; the base action succeeds.
        const status = id === specialId ? 'skipped' as const : 'succeeded' as const;
        return { actionId: id, status, steps: [], ranAt: new Date().toISOString() };
      },
    });

    const runs = await dispatcher.handleTwitchEvent({ kind: 'sub', eventId: 'evt-4', actor: 'Sorlus', login: 'sorlus' });

    expect(calls.map(call => call.actionId)).toEqual([specialId, actionId]);
    expect(runs[0]!.actionId).toBe(actionId);
    expect(runs[0]!.result.status).toBe('succeeded');
    // One claimed run row, its detail recording the substitution.
    const rows = db.prepare('select detail from automation_runs').all() as Array<{ detail: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.detail).toStartWith('Override for sorlus skipped; ran the base action.');
  });

  test('a failed override run does NOT fall back — it may have broadcast', async () => {
    const specialId = specialAction();
    const created = trigger({ kind: 'twitch_event', config: { eventKind: 'sub' } });
    upsertTriggerOverride(created.id, { login: 'sorlus', actionId: specialId, enabled: true, note: '' });

    const calls: string[] = [];
    const { dispatcher } = setup({
      runAction: async (id: string) => {
        calls.push(id);
        return { actionId: id, status: 'failed' as const, steps: [], ranAt: new Date().toISOString() };
      },
    });

    const runs = await dispatcher.handleTwitchEvent({ kind: 'sub', eventId: 'evt-5', actor: 'Sorlus', login: 'sorlus' });

    expect(calls).toEqual([specialId]);
    expect(runs[0]!.result.status).toBe('failed');
  });

  test('the override run arms the base trigger cooldowns (shared throttle)', async () => {
    const specialId = specialAction();
    const created = trigger({ kind: 'twitch_event', config: { eventKind: 'sub' }, globalCooldownMs: 60_000 });
    upsertTriggerOverride(created.id, { login: 'sorlus', actionId: specialId, enabled: true, note: '' });
    const { dispatcher, runner } = setup();

    await dispatcher.handleTwitchEvent({ kind: 'sub', eventId: 'evt-6', actor: 'Sorlus', login: 'sorlus' });
    await dispatcher.handleTwitchEvent({ kind: 'sub', eventId: 'evt-7', actor: 'Frodo', login: 'frodo' });

    // Frodo's generic alert is gated by the same trigger's global cooldown.
    expect(runner.calls).toHaveLength(1);
  });

  test('runTriggerManually with a login exercises the override path', async () => {
    const specialId = specialAction();
    const created = trigger({ kind: 'twitch_event', config: { eventKind: 'sub' } });
    upsertTriggerOverride(created.id, { login: 'sorlus', actionId: specialId, enabled: true, note: '' });
    const { dispatcher, runner } = setup();

    await dispatcher.runTriggerManually(created.id, { login: 'sorlus' });

    expect(runner.calls[0]!.actionId).toBe(specialId);
  });
});
```

Note: the file's `trigger()` helper spreads `input` over defaults, so `globalCooldownMs: 60_000` in the fifth test overrides the default 0.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/server/triggerDispatcher.test.ts`
Expected: the new describe FAILS (base action runs instead of override); every pre-existing test still PASSES.

- [ ] **Step 3: Implement**

In `src/server/triggerDispatcher.ts`, add the import after line 16 (`automationTriggers` import):

```ts
import { resolveOverrideActionId } from './triggerOverrides';
```

Replace the body of `invoke()` from `const runId = crypto.randomUUID();` (line 248) through the final `return` (line 263) with:

```ts
    const runId = crypto.randomUUID();
    if (!claim(runId, trigger, eventId, actorLogin, at)) return null;

    // Per-viewer substitution: the override decides WHICH Action this one claimed
    // invocation runs — never whether a second one runs. See triggerOverrides.ts.
    const overrideActionId = actorLogin ? resolveOverrideActionId(trigger.id, actorLogin) : null;
    let actionId = overrideActionId ?? trigger.actionId;
    let detailPrefix = '';

    let result: ActionRunResult;
    try {
      result = await runAction(actionId, context);
      if (overrideActionId && result.status === 'skipped') {
        // A skipped run broadcast nothing (executor invariant), so the base Action can
        // still deliver the generic alert — the viewer gets fallback, not silence, once.
        actionId = trigger.actionId;
        detailPrefix = `Override for ${actorLogin} skipped; ran the base action. `;
        result = await runAction(trigger.actionId, context);
      }
    } catch (error) {
      const detail = errorText(error);
      console.error(`Automation: trigger ${trigger.id} failed:`, error);
      finishRun.run('failed', `${detailPrefix}${detail}`.slice(0, MAX_DETAIL_LENGTH), runId);
      result = { actionId, status: 'failed', steps: [], ranAt: at.toISOString() };
      return { triggerId: trigger.id, actionId, result };
    }

    finishRun.run(result.status, `${detailPrefix}${detailOf(result)}`.slice(0, MAX_DETAIL_LENGTH), runId);
    return { triggerId: trigger.id, actionId, result };
```

(The only semantic changes from the current body: `actionId` may be the override's; the skipped-override branch; and the `detailPrefix` on `finishRun`. `failed`/`partial`/`succeeded` override runs return as-is.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/server/triggerDispatcher.test.ts`
Expected: PASS, including all pre-existing tests (chat phrase, cooldowns, dedup, module arming, slash).

- [ ] **Step 5: Commit**

```bash
git add src/server/triggerDispatcher.ts src/server/triggerDispatcher.test.ts
git commit -m "feat: resolve per-viewer overrides at invoke time with skip-fallback"
```

---

### Task 4: End-to-end exactly-once coverage in redeemOnce

**Files:**
- Test: `src/server/redeemOnce.test.ts` (extend)

**Interfaces:**
- Consumes: the file's existing migrated fixtures (`REWARD_ID` reward trigger playing `/clips/dinosaur.mp4`), its `emitted` broadcast spy, `handleEventSubNotification`, and Task 2's `upsertTriggerOverride`.

- [ ] **Step 1: Write the failing tests**

In `src/server/redeemOnce.test.ts`: add `'trigger_overrides'` to the table-cleanup list in `beforeEach` (before `'automation_triggers'`), add dynamic imports next to the existing ones:

```ts
const { createAction } = await import('./actions');
const { upsertTriggerOverride } = await import('./triggerOverrides');
```

Then append a new describe. It locates the migrated reward trigger from the DB (the migration created it; its id is not otherwise exposed):

```ts
describe('per-viewer overrides keep the exactly-once guarantee', () => {
  function migratedRewardTriggerId(): string {
    const row = db.prepare("select id from automation_triggers where kind = 'reward'").get() as { id: string };
    return row.id;
  }

  test('an overridden redeem broadcasts the override, not the base — once', async () => {
    // show_text instead of play_media so the assertion does not depend on files on disk.
    const special = createAction({
      name: 'Sorlus special', description: '', enabled: true,
      steps: [{ type: 'show_text', enabled: true, delayMs: 0, payload: { template: 'SORLUS SPECIAL', durationMs: 6000, style: 'banner' } }],
    });
    upsertTriggerOverride(migratedRewardTriggerId(), { login: 'sorlus', actionId: special.id, enabled: true, note: '' });

    await handleEventSubNotification(new RuntimeState(), 'channel.channel_points_custom_reward_redemption.add', {
      user_name: 'Sorlus', user_login: 'sorlus', reward: { id: REWARD_ID, title: 'Play a clip' },
    }, 'evt-override-1');

    expect(emitted.filter(entry => entry.event === 'media:play')).toHaveLength(0);
    const texts = emitted.filter(entry => entry.event === 'overlay:text');
    expect(texts).toHaveLength(1);
    expect(texts[0]!.text).toBe('SORLUS SPECIAL');

    // Redelivery of the same EventSub message must produce no alert output.
    // (stream:event still fires — eventsub.ts broadcasts the event-feed entry before
    // the dedup gate, which is pre-existing behavior outside this invariant.)
    emitted.length = 0;
    await handleEventSubNotification(new RuntimeState(), 'channel.channel_points_custom_reward_redemption.add', {
      user_name: 'Sorlus', user_login: 'sorlus', reward: { id: REWARD_ID, title: 'Play a clip' },
    }, 'evt-override-1');
    expect(emitted.filter(entry => entry.event === 'media:play' || entry.event === 'overlay:text')).toHaveLength(0);
  });

  test('a skipped override falls back to the base clip — exactly one media:play', async () => {
    // play_media on an asset id that exists in no catalog: the run rolls up skipped.
    const broken = createAction({
      name: 'Sorlus broken special', description: '', enabled: true,
      steps: [{ type: 'play_media', enabled: true, delayMs: 0, payload: { assetIds: ['no-such-asset'], selection: 'first' } }],
    });
    upsertTriggerOverride(migratedRewardTriggerId(), { login: 'sorlus', actionId: broken.id, enabled: true, note: '' });

    await handleEventSubNotification(new RuntimeState(), 'channel.channel_points_custom_reward_redemption.add', {
      user_name: 'Sorlus', user_login: 'sorlus', reward: { id: REWARD_ID, title: 'Play a clip' },
    }, 'evt-override-2');

    const plays = emitted.filter(entry => entry.event === 'media:play');
    expect(plays).toHaveLength(1);
    expect(plays[0]!.src).toBe('/clips/dinosaur.mp4');
  });
});
```

Note: `normalizeStepPayload` (`src/server/actions.ts:205-223`) only trims and caps `assetIds` — it does not check them against `media_assets` — so `createAction` accepts `['no-such-asset']` and the run skips at execution time via `pickAsset`, which is exactly the degraded state under test.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/server/redeemOnce.test.ts`
Expected: the new describe FAILS only if Task 3 is not yet merged — on top of Tasks 1-3 it should PASS immediately. If it passes on first run, deliberately break the dispatcher (return `trigger.actionId` unconditionally) to watch the first test fail, then restore. The point of this file is catching double-plays; prove it can.

- [ ] **Step 3: Run the file plus the executor suite**

Run: `bun test src/server/redeemOnce.test.ts src/server/actionExecutor.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/server/redeemOnce.test.ts
git commit -m "test: pin exactly-once through per-viewer override and fallback paths"
```

---

### Task 5: Flush integration

**Files:**
- Modify: `src/shared/api.ts` (`ViewerFlushResult`, ~line 541)
- Modify: `src/server/viewerIdentity.ts` (`flushViewer`, lines 188-206)
- Modify: `src/server/viewers.ts` (flush route, lines 154-166)
- Modify: `src/client/pages/ViewerDetailPage.tsx` (flush note, lines 93-99)
- Test: `src/server/viewerIdentity.test.ts` (extend the existing `describe('flushViewer', ...)`)

**Interfaces:**
- Consumes: `deleteOverridesForLogin(login): number` from Task 2.
- Produces: `flushViewer` returns `{ messages, quotes, interactions, overrides }`; `ViewerFlushResult` gains `overridesRemoved: number`.

- [ ] **Step 1: Write the failing test**

In `src/server/viewerIdentity.test.ts`, inside the existing `describe('flushViewer', ...)` block, add (the file's beforeEach clears viewer tables; the automation tables need explicit setup here):

```ts
  test('flush deletes the login trigger overrides and reports the count; unflush does not resurrect them', () => {
    db.exec('delete from trigger_overrides');
    db.exec('delete from automation_triggers');
    db.exec('delete from action_steps');
    db.exec('delete from actions');
    const action = createAction({
      name: 'Flush target action', description: '', enabled: true,
      steps: [{ type: 'send_chat', enabled: true, delayMs: 0, payload: { template: 'hi', sender: 'bot' } }],
    });
    const created = createAutomationTrigger({
      kind: 'twitch_event', actionId: action.id, moduleId: null, enabled: true,
      globalCooldownMs: 0, userCooldownMs: 0, config: { eventKind: 'sub' },
    });
    upsertTriggerOverride(created.id, { login: 'badbot', actionId: action.id, enabled: true, note: '' });

    const removed = flushViewer('badbot');

    expect(removed.overrides).toBe(1);
    expect(db.prepare('select count(*) as n from trigger_overrides').get()).toEqual({ n: 0 });

    unflushViewer('badbot');
    expect(db.prepare('select count(*) as n from trigger_overrides').get()).toEqual({ n: 0 });
  });
```

Add the imports at the top of the test file:

```ts
import { createAction } from './actions';
import { createAutomationTrigger } from './automationTriggers';
import { upsertTriggerOverride } from './triggerOverrides';
```

(`db`, `flushViewer`, `unflushViewer` are already imported.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/server/viewerIdentity.test.ts`
Expected: FAIL — `removed.overrides` is `undefined`.

- [ ] **Step 3: Implement**

`src/shared/api.ts`, inside `ViewerFlushResult` after `interactionsRemoved` (~line 555), add:

```ts
  /**
   * Per-viewer trigger overrides deleted. An override without its viewer is
   * meaningless, and unlike quote numbers nothing public circulates — so these are
   * removed, not anonymized, and unflushViewer cannot restore them.
   */
  overridesRemoved: number;
```

`src/server/viewerIdentity.ts`: add `import { deleteOverridesForLogin } from './triggerOverrides';` with the other imports, then change `flushViewer`:

```ts
export function flushViewer(login: string, reason = ''): { messages: number; quotes: number; interactions: number; overrides: number } {
  const key = login.trim().toLowerCase();
  if (!key) return { messages: 0, quotes: 0, interactions: 0, overrides: 0 };
  const now = new Date().toISOString();

  let messages = 0;
  let quotes = 0;
  let interactions = 0;
  let overrides = 0;
  db.transaction(() => {
    insertIgnored.run(key, reason, now);
    deleteChatter.run(key);
    deleteProfile.run(key);
    messages = (deleteMessages.run(key) as { changes: number }).changes;
    quotes = anonymizeQuotesByLogin(key);
    interactions = deleteInteractionsForLogin(key);
    // Trigger overrides go too, or a flushed viewer keeps a personalized alert armed
    // in operator config that nothing on the dashboard would surface.
    overrides = deleteOverridesForLogin(key);
  })();

  return { messages, quotes, interactions, overrides };
}
```

Also extend the function's doc comment with one line: `Per-viewer trigger overrides are deleted outright — an override without its viewer is meaningless.`

`src/server/viewers.ts` flush route (lines 159-166):

```ts
    const { messages, quotes, interactions, overrides } = flushViewer(login, reason);
    response.json({
      login,
      messagesRemoved: messages,
      quotesAnonymized: quotes,
      interactionsRemoved: interactions,
      overridesRemoved: overrides,
    } satisfies ViewerFlushResult);
```

`src/client/pages/ViewerDetailPage.tsx` (lines 94-98):

```ts
      .then(result => {
        const quotes = result.quotesAnonymized > 0
          ? `, ${result.quotesAnonymized} quote(s) anonymized`
          : '';
        const overrides = result.overridesRemoved > 0
          ? `, ${result.overridesRemoved} trigger override(s) removed`
          : '';
        setNote(`Flushed — ${result.messagesRemoved} message(s) removed${quotes}${overrides}.`);
        onFlushed?.(login);
      })
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/server/viewerIdentity.test.ts && bun run typecheck`
Expected: PASS / clean. (Typecheck here catches any other `ViewerFlushResult` construction site missing the new field.)

- [ ] **Step 5: Commit**

```bash
git add src/shared/api.ts src/server/viewerIdentity.ts src/server/viewers.ts src/client/pages/ViewerDetailPage.tsx src/server/viewerIdentity.test.ts
git commit -m "feat: flushing a viewer deletes their trigger overrides and reports the count"
```

---

### Task 6: Client service + settings UI

**Files:**
- Modify: `src/client/services/dashboard.ts` (after `runAutomationTrigger`, ~line 697; type import ~line 7)
- Modify: `src/client/pages/settings/automation.ts` (after `supportsCooldowns`, ~line 126)
- Modify: `src/client/pages/settings/AutomationPage.tsx` (imports; `AutomationSettingsPage` state/load; `TriggerEditor`; list row; new `TriggerOverridesSection`)
- Test: `src/client/pages/settings/automation.test.ts` (extend)

**Interfaces:**
- Consumes: routes from Task 2; `TriggerOverride`/`TriggerOverrideInput` types.
- Produces: `getTriggerOverrides(): Promise<TriggerOverride[]>`, `saveTriggerOverride(triggerId, input): Promise<TriggerOverride>`, `deleteTriggerOverride(id): Promise<void>`, `supportsOverrides(kind): boolean`.

- [ ] **Step 1: Write the failing test**

In `src/client/pages/settings/automation.test.ts`, add `supportsOverrides` to the import from `./automation`, then append:

```ts
describe('supportsOverrides', () => {
  test('only kinds where a real viewer arrives on the signal', () => {
    expect(supportsOverrides('reward')).toBe(true);
    expect(supportsOverrides('twitch_event')).toBe(true);
    expect(supportsOverrides('chat_phrase')).toBe(true);
    expect(supportsOverrides('viewer_command')).toBe(true);
    expect(supportsOverrides('dashboard_slash')).toBe(false);
    expect(supportsOverrides('manual')).toBe(false);
    expect(supportsOverrides('module_activate')).toBe(false);
    expect(supportsOverrides('module_deactivate')).toBe(false);
  });
});
```

Run: `bun test src/client/pages/settings/automation.test.ts` — expected FAIL (no export).

- [ ] **Step 2: Implement the pure pieces**

`src/client/pages/settings/automation.ts`, after `supportsCooldowns` (~line 126):

```ts
/** Kinds where a real viewer arrives on the signal, so a per-viewer override can match. */
export function supportsOverrides(kind: AutomationTriggerKind): boolean {
  return kind === 'reward' || kind === 'twitch_event' || kind === 'chat_phrase' || kind === 'viewer_command';
}
```

`src/client/services/dashboard.ts`: add `TriggerOverride, TriggerOverrideInput` to the shared-api type import block, and after `runAutomationTrigger` (~line 697):

```ts
export async function getTriggerOverrides(): Promise<TriggerOverride[]> {
  return fetchJson<TriggerOverride[]>('/api/automation/overrides');
}

export async function saveTriggerOverride(triggerId: string, input: TriggerOverrideInput): Promise<TriggerOverride> {
  return sendJson<TriggerOverride>(`/api/automation/triggers/${encodeURIComponent(triggerId)}/overrides`, 'PUT', input);
}

export async function deleteTriggerOverride(id: string): Promise<void> {
  return sendVoid(`/api/automation/overrides/${encodeURIComponent(id)}`, 'DELETE');
}
```

Run: `bun test src/client/pages/settings/automation.test.ts` — expected PASS.

- [ ] **Step 3: Wire the page**

In `src/client/pages/settings/AutomationPage.tsx`:

1. Imports: add `TriggerOverride` to the shared-api type import; add `getTriggerOverrides, saveTriggerOverride, deleteTriggerOverride` to the services import; add `supportsOverrides` to the `./automation` import.

2. `AutomationSettingsPage` state (~line 457): add

```ts
  const [overrides, setOverrides] = useState<TriggerOverride[]>([]);
```

3. In `load()` (line 470-479; `getViewerRewards` loads in its own effect and is untouched), extend the `Promise.all`:

```ts
    const [nextTriggers, nextActions, nextModules, nextOverrides] = await Promise.all([
      getAutomationTriggers(),
      getActions(),
      getCategoryModules(),
      getTriggerOverrides(),
    ]);
    setTriggers(nextTriggers);
    setActions(nextActions);
    setModules(nextModules.modules);
    setOverrides(nextOverrides);
```

4. Save/delete handlers inside `AutomationSettingsPage`:

```ts
  const saveOverride = useCallback(async (triggerId: string, input: TriggerOverrideInput) => {
    try {
      await saveTriggerOverride(triggerId, input);
      setOverrides(await getTriggerOverrides());
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught, 'Could not save the override.'));
    }
  }, []);

  const removeOverride = useCallback(async (id: string) => {
    try {
      await deleteTriggerOverride(id);
      setOverrides(await getTriggerOverrides());
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught, 'Could not remove the override.'));
    }
  }, []);
```

(add `TriggerOverrideInput` to the type import too)

5. Pass into `TriggerEditor` where it is rendered: `overrides={editingId ? overrides.filter(o => o.triggerId === editingId) : []}`, `onSaveOverride={saveOverride}`, `onDeleteOverride={removeOverride}`.

6. `TriggerEditor`: add to props —

```ts
  overrides: TriggerOverride[];
  onSaveOverride: (triggerId: string, input: TriggerOverrideInput) => void;
  onDeleteOverride: (id: string) => void;
```

and render after the `supportsCooldowns` line (line 442):

```tsx
        {supportsOverrides(draft.kind) && (
          editingId ? (
            <TriggerOverridesSection
              triggerId={editingId}
              overrides={overrides}
              actions={actions}
              disabled={saving}
              onSave={onSaveOverride}
              onDelete={onDeleteOverride}
            />
          ) : (
            <small className="action-hint">Save the trigger first, then add per-viewer overrides.</small>
          )
        )}
```

7. New component in the same file (above `TriggerEditor`):

```tsx
/**
 * Per-viewer overrides for one saved trigger. Rows save immediately via their own
 * endpoint — they are separate resources, deliberately outside the trigger form's
 * draft/save cycle so an override edit cannot be lost to an unsaved trigger draft.
 */
function TriggerOverridesSection({
  triggerId,
  overrides,
  actions,
  disabled,
  onSave,
  onDelete,
}: {
  triggerId: string;
  overrides: TriggerOverride[];
  actions: Action[];
  disabled: boolean;
  onSave: (triggerId: string, input: TriggerOverrideInput) => void;
  onDelete: (id: string) => void;
}) {
  const [newLogin, setNewLogin] = useState('');
  const [newActionId, setNewActionId] = useState('');

  const addProblem = (() => {
    if (!newLogin.trim()) return null; // untouched: no nagging
    const login = newLogin.trim().replace(/^@+/, '').toLowerCase();
    if (!/^[a-z0-9_]{1,25}$/.test(login)) return 'Logins use letters, numbers, or underscores.';
    if (overrides.some(existing => existing.login === login)) return `${login} already has an override on this trigger.`;
    return null;
  })();

  const add = () => {
    if (addProblem || !newLogin.trim() || !newActionId) return;
    onSave(triggerId, {
      login: newLogin.trim().replace(/^@+/, '').toLowerCase(),
      actionId: newActionId,
      enabled: true,
      note: '',
    });
    setNewLogin('');
    setNewActionId('');
  };

  return (
    <div className="field">
      <span>Per-viewer overrides</span>
      {overrides.map(override => (
        <div className="command-row-actions" key={override.id}>
          <code>{override.login}</code>
          <select
            value={override.actionId}
            disabled={disabled}
            onChange={event => onSave(triggerId, {
              login: override.login, actionId: event.target.value, enabled: override.enabled, note: override.note,
            })}
          >
            {actions.map(action => (
              <option key={action.id} value={action.id}>
                {action.name}{action.enabled ? '' : ' (disabled)'}
              </option>
            ))}
          </select>
          <label className="command-enabled">
            <input
              type="checkbox"
              checked={override.enabled}
              disabled={disabled}
              onChange={event => onSave(triggerId, {
                login: override.login, actionId: override.actionId, enabled: event.target.checked, note: override.note,
              })}
            />
            <span>On</span>
          </label>
          <button className="modbtn danger" type="button" disabled={disabled} onClick={() => onDelete(override.id)}>
            Remove
          </button>
        </div>
      ))}
      <div className="command-row-actions">
        <input
          type="text"
          value={newLogin}
          maxLength={26}
          placeholder="viewer login"
          disabled={disabled}
          onChange={event => setNewLogin(event.target.value)}
        />
        <select value={newActionId} disabled={disabled} onChange={event => setNewActionId(event.target.value)}>
          <option value="">Runs this action instead…</option>
          {actions.map(action => (
            <option key={action.id} value={action.id}>
              {action.name}{action.enabled ? '' : ' (disabled)'}
            </option>
          ))}
        </select>
        <button
          className="modbtn"
          type="button"
          disabled={disabled || Boolean(addProblem) || !newLogin.trim() || !newActionId}
          onClick={add}
        >
          Add
        </button>
      </div>
      {addProblem && <small className="action-hint">{addProblem}</small>}
      <small className="action-hint">
        If the override's action can't run (skipped), the trigger's normal action plays
        instead. Cooldowns are shared with this trigger.
      </small>
    </div>
  );
}
```

8. List row tag: in `AutomationSettingsPage`, compute counts —

```ts
  const overrideCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const override of overrides) counts[override.triggerId] = (counts[override.triggerId] ?? 0) + 1;
    return counts;
  }, [overrides]);
```

…and inside the list row's `media-asset-tags` div (after the cooldown tags, ~line 668), add:

```tsx
                              {(overrideCounts[trigger.id] ?? 0) > 0 && (
                                <span className="media-asset-tag">
                                  {overrideCounts[trigger.id]} viewer override{overrideCounts[trigger.id] === 1 ? '' : 's'}
                                </span>
                              )}
```

- [ ] **Step 4: Typecheck and eyeball**

Run: `bun run typecheck`
Expected: clean. Then start the dev server against a scratch DB and verify in the browser (Settings → Automation): create a `twitch_event: sub` trigger, save it, add an override for `sorlus` pointing at a second Action, confirm the list row shows `1 viewer override`, toggle/remove it. Use the project's preview tooling — target port free first per CLAUDE.md.

- [ ] **Step 5: Commit**

```bash
git add src/client/services/dashboard.ts src/client/pages/settings/automation.ts src/client/pages/settings/automation.test.ts src/client/pages/settings/AutomationPage.tsx
git commit -m "feat: per-viewer overrides editor in the trigger settings page"
```

---

### Task 7: Docs + full verification

**Files:**
- Modify: `CLAUDE.md` (Automation platform section)

- [ ] **Step 1: Document the layer**

In `CLAUDE.md`, in the **Automation platform** section, after the `automation_triggers` bullet, add:

```markdown
- `trigger_overrides` (`triggerOverrides.ts`) — per-viewer Action substitution: `(trigger, login) → alternate Action`, resolved inside the dispatcher's `invoke()` after the gates and before the run. The base trigger still matches once, claims one dedupe key, and owns the cooldowns, so a double alert is structurally impossible. A `skipped` override run falls back to the base Action under the same run row (safe because a skipped run broadcasts nothing); `partial`/`failed` do not fall back. Anonymous events (no login) and flushed viewers never match; `flushViewer` deletes a viewer's overrides and reports the count.
```

- [ ] **Step 2: Full verification**

```bash
bun run typecheck
bun test
bun run build
```

Expected: all clean/pass (modulo the known worktree-only media failures if running in a worktree). Then smoke end-to-end against a scratch DB:

```bash
STREAMER_TOOLS_DB=/tmp/claude-1000/-home-codeacula-Storage-Projects-narya/cfcef080-b39c-4f3e-b44f-b1fc85708c3e/scratchpad/overrides-smoke.sqlite bun src/server/index.ts
```

(confirm port 4317 is free first: `lsof -i :4317`) — then with the dashboard token:

1. `POST /api/actions` twice (base + special), `POST /api/automation/triggers` (`twitch_event: sub` → base).
2. `PUT /api/automation/triggers/<id>/overrides` with `{ "login": "sorlus", "actionId": "<special>", "enabled": true, "note": "" }` → 200 with the normalized row.
3. `POST /api/automation/triggers/<id>/run` with `{ "login": "sorlus" }` → the run result's `actionId` is the special Action.
4. `POST /api/automation/triggers/<id>/run` with `{ "login": "frodo" }` → base Action.
5. `GET /api/automation/overrides` → the row; `DELETE /api/automation/overrides/<id>` → 204.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: describe the trigger override layer in the automation platform notes"
```
