# Phase B1 — Multi-Action Triggers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A trigger runs **N ordered actions concurrently** (was one), gains a `name`, and the contract switches from `actionId` to `actions: TriggerAction[]` — one `automation_runs` claim per `(trigger, event)` rolling up N results.

**Architecture:** A new `automation_trigger_actions(trigger_id, action_id, position, enabled)` join table (composite PK = the double-play guard) is the source of truth; the legacy `automation_triggers.action_id` stays `NOT NULL`+FK, tracking `actions[0]` (no table rebuild). The dispatcher, after its single claim, fans out to `Promise.all(runAction …)` and rolls up with the same 4-way logic `actionExecutor.rollUp` already uses. The contract change lands **additively** (keep `actionId` alongside `actions[]`) through Tasks 1–5, then Task 6 removes `actionId` for the full switch — so every task keeps the build green.

**Tech Stack:** Bun + TypeScript, Express, `bun:sqlite` (`db.ts`), React (client), `bun test`.

## Global Constraints

- **≥1 action row invariant:** every trigger always has at least one `automation_trigger_actions` row; `normalizeAutomationTriggerInput` rejects an empty `actions[]`, and the editor blocks removing the last action. `action_id` (the legacy column) is set to `actions[0].actionId` on every save and stays `NOT NULL`+FK — **no table rebuild.**
- **"Inert" = zero *enabled* actions.** The dispatcher skips a trigger with no enabled actions **before** the cooldown gate and the claim (no run row, no cooldown consumed). The editor flags it "won't fire" (non-blocking).
- **One claim, N actions.** Exactly one `automation_runs` insert (`dedupe_key = trigger.id:eventId`) and one `finishRun` per `(trigger, event)` — the N-action loop runs *after* the single claim. A per-action loop that claims per action is forbidden (the second collides on the dedupe index and silently no-ops).
- **Composite PK `(trigger_id, action_id)`** stops an action being listed twice on one trigger (the no-redelivery double-play class `redeemOnce.test.ts` guards).
- **Roll-up (reuse `actionExecutor.rollUp` logic):** filter out `skipped`; if none ran → `skipped`; all ran `succeeded` → `succeeded`; all ran `failed` → `failed`; else `partial`.
- **Concurrent execution** (`Promise.all`, t0 model); `position` is display order only.
- **Per-viewer override** replaces the enabled action list with `[overrideAction]` for that login; a `skipped` override run falls back to the base enabled list under the same run row.
- **Migrations:** new table via idempotent `create table if not exists`; `name` column via `addColumnIfMissing` + all three allowlists (`automation_triggers`, `name`, and the lowercased definition); data backfills via `runOnce`; verified in a `*.test.ts` against the in-memory DB, never an ad-hoc script.
- Two-space indent; semicolons; `snake_case`→`camelCase` aliases; prepared statements at module top level. Verify per task with `bun run typecheck` + the covering `bun test <file>`, full `bun test` + `bun run build` at the end.

---

### Task 1: schema + migration (join table, `name`, guard, backfills)

**Files:**
- Modify: `src/server/db.ts` (join-table DDL + index; `name` column + allowlists; `dropStaleTriggerActions` guard + call; two `runOnce` backfills)
- Test: `src/server/db.triggerActionsMigration.test.ts` (new)

**Interfaces:**
- Produces: table `automation_trigger_actions(trigger_id, action_id, position, enabled)`, PK `(trigger_id, action_id)`, FKs both `on delete cascade`; index `idx_automation_trigger_actions_trigger(trigger_id, position)`; column `automation_triggers.name TEXT NOT NULL DEFAULT ''`; exported `dropStaleTriggerActions(database): boolean`.

- [ ] **Step 1: Write the failing test** — `src/server/db.triggerActionsMigration.test.ts`:

```ts
import { beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { db, dropStaleTriggerActions } from './db';

describe('automation_trigger_actions migration', () => {
  test('the join table and name column exist with the shipped shape', () => {
    const cols = db.prepare("pragma table_info('automation_trigger_actions')").all() as Array<{ name: string }>;
    expect(cols.map(c => c.name).sort()).toEqual(['action_id', 'enabled', 'position', 'trigger_id']);
    const triggerCols = db.prepare("pragma table_info('automation_triggers')").all() as Array<{ name: string }>;
    expect(triggerCols.some(c => c.name === 'name')).toBe(true);
  });

  test('the backfill copies action_id into one join row per trigger (insert or ignore)', () => {
    // Seed a legacy trigger row + an action it points to.
    db.prepare("insert into actions (id, name, description, enabled, created_at, updated_at) values ('act1','A','',1,'t','t')").run();
    db.prepare(`insert into automation_triggers (id, kind, action_id, module_id, enabled, config_json, global_cooldown_ms, user_cooldown_ms, created_at, updated_at)
      values ('trg1','manual','act1',null,1,'{"label":"x"}',0,0,'t','t')`).run();
    db.prepare('delete from automation_trigger_actions where trigger_id = ?').run('trg1');
    // Re-run the backfill statement directly (the runOnce already ran at import).
    db.exec("insert or ignore into automation_trigger_actions (trigger_id, action_id, position, enabled) select id, action_id, 0, 1 from automation_triggers");
    const rows = db.prepare('select action_id as actionId, position, enabled from automation_trigger_actions where trigger_id = ?').all('trg1');
    expect(rows).toEqual([{ actionId: 'act1', position: 0, enabled: 1 }]);
  });

  test('dropStaleTriggerActions drops a shape-broken table and clears the backfill ledger', () => {
    const scratch = new Database(':memory:');
    scratch.exec("create table automation_trigger_actions (trigger_id text, action_id text)"); // missing position/enabled/PK
    scratch.exec("create table schema_migrations (id text primary key, applied_at text)");
    scratch.exec("insert into schema_migrations values ('2026-07-trigger-actions-from-action-id','t')");
    expect(dropStaleTriggerActions(scratch)).toBe(true);
    expect(scratch.prepare("pragma table_info('automation_trigger_actions')").all()).toHaveLength(0);
    expect(scratch.prepare("select 1 from schema_migrations where id = '2026-07-trigger-actions-from-action-id'").get()).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test src/server/db.triggerActionsMigration.test.ts`
Expected: FAIL (`dropStaleTriggerActions` not exported; table/column absent).

- [ ] **Step 3: Implement** in `src/server/db.ts`:

Inside the automation `db.exec(\`…\`)` block (before its closing backtick, near the `trigger_overrides` table):
```sql
  create table if not exists automation_trigger_actions (
    trigger_id text not null,
    action_id text not null,
    position integer not null default 0,
    enabled integer not null default 1,
    primary key (trigger_id, action_id),
    foreign key (trigger_id) references automation_triggers(id) on delete cascade,
    foreign key (action_id) references actions(id) on delete cascade
  );
```
In the index `db.exec` block (beside `idx_action_steps_action`):
```sql
  create index if not exists idx_automation_trigger_actions_trigger on automation_trigger_actions(trigger_id, position);
```
Add the guard beside `dropStaleTriggerOverrides` (mirror it; also delete the backfill ledger id on drop):
```ts
const TRIGGER_ACTION_COLUMNS_SHIPPED = ['action_id', 'enabled', 'position', 'trigger_id'];

function hasTriggerActionPrimaryKey(database: Database): boolean {
  const indexes = database.prepare("PRAGMA index_list('automation_trigger_actions')").all() as Array<{ name: string; unique: number; origin: string }>;
  return indexes.some(index => {
    if (!index.unique) return false;
    const columns = (database.prepare(`PRAGMA index_info('${index.name}')`).all() as Array<{ name: string }>)
      .map(c => c.name).sort();
    return columns.length === 2 && columns[0] === 'action_id' && columns[1] === 'trigger_id';
  });
}

export function dropStaleTriggerActions(database: Database): boolean {
  const columns = database.prepare("PRAGMA table_info('automation_trigger_actions')").all() as Array<{ name: string }>;
  if (columns.length === 0) return false;
  const names = columns.map(c => c.name).sort();
  const shipped = [...TRIGGER_ACTION_COLUMNS_SHIPPED].sort();
  const columnsMatch = names.length === shipped.length && names.every((n, i) => n === shipped[i]);
  if (columnsMatch && hasTriggerActionPrimaryKey(database)) return false;
  database.exec('drop table automation_trigger_actions');
  // The backfill copy is a runOnce; its ledger id is already recorded, so a plain drop
  // would leave the table empty. Clear the id so the copy re-runs and restores the
  // >=1-row invariant from action_id.
  database.exec("delete from schema_migrations where id = '2026-07-trigger-actions-from-action-id'");
  return true;
}
```
Call it on the guard shelf beside the others: `dropStaleTriggerActions(db);` — **but** `schema_migrations` must exist before this runs; the guards run before the DDL/`runOnce` engine today. Guard `dropStaleTriggerActions`'s ledger delete with `if exists` semantics: wrap the `delete` in a `try { … } catch {}` OR create `schema_migrations` earlier. Simplest: in the guard, guard the delete: `try { database.exec("delete from schema_migrations where id = '2026-07-trigger-actions-from-action-id'"); } catch { /* ledger not created yet */ }`.

Add the `name` column allowlist entries: `'automation_triggers'` → `allowedMigrationTables`; `'name'` → `allowedMigrationColumns`; `name: "text not null default ''"` → `allowedMigrationDefinitions`. Then in the `addColumnIfMissing` run: `addColumnIfMissing('automation_triggers', 'name', "text not null default ''");`

Add the two backfills after the column add (near `seed-stream-status-raw-text`):
```ts
runOnce('2026-07-trigger-actions-from-action-id', () => {
  db.exec("insert or ignore into automation_trigger_actions (trigger_id, action_id, position, enabled) select id, action_id, 0, 1 from automation_triggers");
});
runOnce('2026-07-backfill-trigger-names', () => {
  db.exec("update automation_triggers set name = kind || ' · ' || substr(id, 1, 6) where name = ''");
});
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test src/server/db.triggerActionsMigration.test.ts` then `bun run typecheck`
Expected: PASS + typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/server/db.ts src/server/db.triggerActionsMigration.test.ts
git commit -m "feat: automation_trigger_actions join table + name column + backfills"
```

---

### Task 2: contract (additive) + repo writes/reads `actions[]`

**Files:**
- Modify: `src/shared/api.ts` (`TriggerAction`, `name`+`actions[]` on all 8 members **keeping `actionId`**, `TriggerRunResult`)
- Modify: `src/server/automationTriggers.ts` (Row/columns/statements + `name`; join read/write; `normalize`; `rowToTrigger`; `create`/`update` → transaction)
- Test: `src/server/automationTriggers.test.ts` (extend)

**Interfaces:**
- Consumes: the join table (Task 1).
- Produces: `TriggerAction = { actionId: string; position: number; enabled: boolean }`; every `AutomationTrigger` member carries `name: string`, `actions: TriggerAction[]`, **and still** `actionId: string` (removed in Task 6); `TriggerRunResult = { status: ActionRunStatus; actions: ActionRunResult[] }`; the repo writes N join rows transactionally and reads `actions[]` ordered by `position`.

- [ ] **Step 1: Write the failing test** — extend `automationTriggers.test.ts` (seed two actions first via the repo/`db`):

```ts
test('a trigger persists N ordered actions and reads them back', () => {
  // seed two enabled actions act1, act2 (via createAction or direct insert)
  const trigger = createAutomationTrigger({
    kind: 'manual', name: 'My combo', moduleId: null, enabled: true,
    globalCooldownMs: 0, userCooldownMs: 0, config: { label: 'x' },
    actions: [{ actionId: act1, position: 0, enabled: true }, { actionId: act2, position: 1, enabled: false }],
  });
  expect(trigger.name).toBe('My combo');
  expect(trigger.actions).toEqual([
    { actionId: act1, position: 0, enabled: true },
    { actionId: act2, position: 1, enabled: false },
  ]);
  // legacy column tracks actions[0]
  const row = db.prepare('select action_id as a from automation_triggers where id = ?').get(trigger.id) as { a: string };
  expect(row.a).toBe(act1);
});

test('rejects an empty actions[] and a duplicate action', () => {
  expect(() => createAutomationTrigger({ kind: 'manual', name: 'n', moduleId: null, enabled: true, globalCooldownMs: 0, userCooldownMs: 0, config: { label: 'x' }, actions: [] })).toThrow(/at least one action/i);
  expect(() => createAutomationTrigger({ /* …*/ actions: [{ actionId: act1, position: 0, enabled: true }, { actionId: act1, position: 1, enabled: true }] })).toThrow();
});
```

- [ ] **Step 2: Run to verify it fails** — `bun test src/server/automationTriggers.test.ts` → FAIL (`actions` not accepted/returned).

- [ ] **Step 3: Implement** (mirror `actions.ts`'s parent+ordered-join transaction):

`src/shared/api.ts`:
```ts
export type TriggerAction = { actionId: string; position: number; enabled: boolean };
export type TriggerRunResult = { status: ActionRunStatus; actions: ActionRunResult[] };
```
Add `name: string;` and `actions: TriggerAction[];` to **every** `AutomationTrigger` member (keep `actionId: string;` for now). `AutomationTriggerInput` derives automatically.

`src/server/automationTriggers.ts`:
- `TriggerRow` += `name: string`; `TRIGGER_COLUMNS` += `name,`; `insertTriggerRow`/`updateTriggerRow` SQL += `name` (in the insert column list / update set).
- New statements:
```ts
const listTriggerActionRows = db.prepare('select action_id as actionId, position, enabled from automation_trigger_actions where trigger_id = ? order by position asc');
const insertTriggerActionRow = db.prepare('insert into automation_trigger_actions (trigger_id, action_id, position, enabled) values (?, ?, ?, ?)');
const deleteTriggerActionsForTrigger = db.prepare('delete from automation_trigger_actions where trigger_id = ?');
```
- `normalizeAutomationTriggerInput`: after the `kind` check add `const name = requireText(value.name, MAX_LABEL_LENGTH, 'Name is required.');`. Replace the single-action block with an array validation:
```ts
if (!Array.isArray(value.actions)) throw new HttpRouteError(400, 'actions must be an array.');
const seen = new Set<string>();
const actions = value.actions.map((raw, index) => {
  const entry = asRecord(raw);
  const actionId = typeof entry.actionId === 'string' ? entry.actionId.trim() : '';
  if (!actionId || !actionExists.get(actionId)) throw new HttpRouteError(400, 'Action not found.');
  if (seen.has(actionId)) throw new HttpRouteError(400, 'An action may only be listed once per trigger.');
  seen.add(actionId);
  return { actionId, position: index, enabled: typeof entry.enabled === 'boolean' ? entry.enabled : true };
});
if (actions.length === 0) throw new HttpRouteError(400, 'A trigger needs at least one action.');
```
  Return `{ kind, name, actions, actionId: actions[0].actionId, moduleId, enabled, …cooldowns, config }`.
- `rowToTrigger`: add `name: row.name,` and `actions: listTriggerActionRows.all(row.id) as TriggerAction[],` (keep `actionId: row.actionId,`).
- Convert `create`/`update` to the `db.transaction` idiom (mirror `actions.ts:426-438` + `saveSteps`):
```ts
function saveTriggerActions(triggerId: string, actions: TriggerAction[]) {
  deleteTriggerActionsForTrigger.run(triggerId);
  actions.forEach((a, index) => insertTriggerActionRow.run(triggerId, a.actionId, index, a.enabled ? 1 : 0));
}
const createTriggerRecord = db.transaction((input: AutomationTriggerInput) => {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  insertTriggerRow.run(id, input.kind, input.name, input.actions[0].actionId, input.moduleId, input.enabled ? 1 : 0, JSON.stringify(input.config), input.globalCooldownMs, input.userCooldownMs, now, now);
  saveTriggerActions(id, input.actions);
  return id;
});
// updateTriggerRecord mirrors it (update row incl. name + action_id = actions[0], then saveTriggerActions).
```
  `createAutomationTrigger`/`updateAutomationTrigger` call the txn then re-read via `getAutomationTrigger`.

- [ ] **Step 4: Run to verify it passes** — `bun test src/server/automationTriggers.test.ts` + `bun run typecheck` → PASS/clean.

- [ ] **Step 5: Commit**

```bash
git add src/shared/api.ts src/server/automationTriggers.ts src/server/automationTriggers.test.ts
git commit -m "feat: triggers persist name + ordered actions[] (additive; actionId retained)"
```

---

### Task 3: seeds + legacy creators write a join row

**Files:**
- Modify: `src/server/automationTriggers.ts` (`seedBuiltInSlashCommands`), `src/server/legacyMigration.ts` (4 creators)
- Test: `src/server/automationTriggers.test.ts` / `src/server/legacyMigration.test.ts` (extend)

**Interfaces:** consumes the join write (Task 1/2). Every seed/legacy creator now also writes one `automation_trigger_actions` row and a `name`.

- [ ] **Step 1: Write the failing test** — assert a seeded slash command and a migrated legacy trigger each have exactly one join row (`position 0, enabled 1`) and a non-empty `name`. (Both run at import via `runOnce`; assert post-import state, or call the exported seed/migration fn against a scratch context if the test file already does so.)

- [ ] **Step 2: Run to verify it fails** — the seed/migration triggers have no join row yet → FAIL.

- [ ] **Step 3: Implement**
- `seedBuiltInSlashCommands` (`automationTriggers.ts`): hoist `const triggerId = crypto.randomUUID();`, pass a `name` (e.g. `seed.command`) into the `insertTriggerRow.run(...)` (now includes `name`), and add `insertTriggerActionRow.run(triggerId, actionId, 0, 1);`.
- `legacyMigration.ts`: its local `insertTrigger` prepared statement gains `name`; each of the 4 creators (`migrateLegacyChatbotCommands`, `migrateLegacyRewardBindings`, `migrateLegacyAlerts`, `migrateQuackCommandIntoAction`) hoists its trigger id, passes a `name`, and inserts one join row via a local `insert into automation_trigger_actions …` prepared statement (or the shared one imported).
  - **Ordering safety:** the Task-1 backfill uses `insert or ignore`, so it never collides with a seed/legacy row written first. Keep it that way.

- [ ] **Step 4: Run to verify it passes** — `bun test src/server/automationTriggers.test.ts src/server/legacyMigration.test.ts` + `bun run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add src/server/automationTriggers.ts src/server/legacyMigration.ts src/server/automationTriggers.test.ts src/server/legacyMigration.test.ts
git commit -m "feat: seeded + legacy trigger creators write a join row and a name"
```

---

### Task 4: dispatcher runs `actions[]` and rolls up

**Files:**
- Modify: `src/server/triggerDispatcher.ts` (`invoke`, `TriggerRunSummary`, `handleSlashCommand`, `runTriggerManually`)
- Modify: `src/shared/api.ts` (`SlashCommandResponse.run: TriggerRunResult | null`)
- Test: `src/server/triggerDispatcher.test.ts` (extend), `src/server/redeemOnce.test.ts` (extend)

**Interfaces:**
- Consumes: `trigger.actions` (Task 2), `TriggerRunResult` (Task 2).
- Produces: `TriggerRunSummary = { triggerId: string; status: ActionRunStatus; actions: ActionRunResult[] }`; `handleSlashCommand`/`runTriggerManually` return `TriggerRunResult`-shaped run data.

- [ ] **Step 1: Write the failing test** (in `triggerDispatcher.test.ts`, which already stubs `runAction` via a `RunCall` recorder):

```ts
test('runs all enabled actions once and rolls up; one run row', async () => {
  // trigger with actions [a1 enabled, a2 disabled, a3 enabled]; stub runAction to 'succeeded'
  const summaries = await dispatcher.handleTwitchEvent(signal);
  expect(runCalls.map(c => c.actionId).sort()).toEqual([a1, a3].sort()); // a2 skipped (disabled)
  expect(summaries[0].status).toBe('succeeded');
  expect(summaries[0].actions).toHaveLength(2);
  expect(db.prepare('select count(*) as n from automation_runs where trigger_id = ?').get(triggerId)).toEqual({ n: 1 });
});

test('a trigger with zero enabled actions never claims (no run row, no cooldown burned)', async () => {
  // trigger with all actions disabled
  await dispatcher.handleTwitchEvent(signal);
  expect(db.prepare('select count(*) as n from automation_runs where trigger_id = ?').get(triggerId)).toEqual({ n: 0 });
});
```

- [ ] **Step 2: Run to verify it fails** — current `invoke` runs a single `trigger.actionId` → the multi-run / zero-enabled assertions FAIL.

- [ ] **Step 3: Implement** — rewrite `invoke` (`triggerDispatcher.ts:238-282`):
- After `isArmed`, compute `const enabled = trigger.actions.filter(a => a.enabled).sort((x, y) => x.position - y.position);` and **`if (enabled.length === 0) return null;`** — before `isOnCooldown` and `claim`.
- After the single `claim(...)`, resolve the override list: `const overrideActionId = actorLogin ? resolveOverrideActionId(trigger.id, actorLogin) : null;` then `let list = overrideActionId ? [overrideActionId] : enabled.map(a => a.actionId);`.
- Run concurrently + roll up:
```ts
let results = await Promise.all(list.map(id => runAction(id, context)));
let status = rollUpActions(results);
if (overrideActionId && status === 'skipped') {
  const skipReason = detailOf(results[0]);
  detailPrefix = `Override for ${actorLogin} skipped${skipReason ? ` (${skipReason})` : ''}; ran the base actions. `;
  results = await Promise.all(enabled.map(a => runAction(a.actionId, context)));
  status = rollUpActions(results);
}
finishRun.run(status, `${detailPrefix}${summarizeResults(results)}`.slice(0, MAX_DETAIL_LENGTH), runId);
return { triggerId: trigger.id, status, actions: results };
```
  where `rollUpActions(results: ActionRunResult[]): ActionRunStatus` copies `actionExecutor.rollUp`'s 4-way logic over `results[].status` (`ran = results.filter(r => r.status !== 'skipped')`; none → `skipped`; all `succeeded` → `succeeded`; all `failed` → `failed`; else `partial`), and `summarizeResults` builds a short detail. Keep the `try/catch` around the whole run (a thrown `runAction` → `finishRun('failed', …)` + return a failed summary).
- `TriggerRunSummary` → `{ triggerId: string; status: ActionRunStatus; actions: ActionRunResult[] }`.
- `handleSlashCommand` (`:525-534`): build `run: { status: summary.status, actions: summary.actions }` (a `TriggerRunResult`); `runTriggerManually` (`:537-547`) returns the same shape (its route returns it directly).
- `src/shared/api.ts`: `SlashCommandResponse.run: TriggerRunResult | null`.

- [ ] **Step 4: Run to verify it passes** — `bun test src/server/triggerDispatcher.test.ts src/server/redeemOnce.test.ts` + `bun run typecheck`. Extend `redeemOnce.test.ts` to assert a redelivered multi-action trigger still claims one dedupe key (no replay) and the PK rejects listing one action twice.

- [ ] **Step 5: Commit**

```bash
git add src/server/triggerDispatcher.ts src/shared/api.ts src/server/triggerDispatcher.test.ts src/server/redeemOnce.test.ts
git commit -m "feat: dispatcher runs N enabled actions concurrently, one claim, rolled-up status"
```

---

### Task 5: editor + client run-result display

**Files:**
- Modify: `src/client/pages/settings/automation.ts` (`MAX_ACTIONS_PER_TRIGGER`, `validateTrigger`, `runResultTone`/`summarizeRunResult` for `TriggerRunResult`, `triggerToInput`)
- Modify: `src/client/pages/settings/AutomationPage.tsx` (`newTrigger`, name input, ordered action-list editor, list rendering, run display)
- Modify: `src/client/quickActions.tsx` (manual-run result display)
- Test: `src/client/pages/settings/automation.test.ts` (extend)

**Interfaces:** consumes `TriggerAction`/`TriggerRunResult` (Tasks 2/4). No server change.

- [ ] **Step 1: Write the failing test** — in `automation.test.ts`: `validateTrigger` returns an error for empty `actions`, null for ≥1; `triggerToInput` round-trips `name` + `actions`; `moveStep`/`removeStep` reorder an actions array (they're generic already).

- [ ] **Step 2: Run to verify it fails** — `validateTrigger` still reads `trigger.actionId` → FAIL on the `actions` shape.

- [ ] **Step 3: Implement**
- `automation.ts`: `export const MAX_ACTIONS_PER_TRIGGER = 20;` (mirror `MAX_STEPS`). `validateTrigger`: replace `if (!trigger.actionId) return 'Pick the action this trigger runs.';` with `if (trigger.actions.length === 0) return 'Add at least one action.';` and a `> MAX_ACTIONS_PER_TRIGGER` cap. Reshape `runResultTone`/`summarizeRunResult` to accept `TriggerRunResult` (switch on `.status`, summarize across `.actions`); keep `ActionsPage`'s standalone single-`ActionRunResult` display working (that page runs a bare Action, not a trigger — give it its own small helper or a narrow overload rather than breaking its call site).
- `AutomationPage.tsx`: `newTrigger` base → `name: '', actions: []` (drop `actionId`). Replace the single-action `<select>` (`:519-533`) with an ordered action-list editor modeled on `ActionsPage`'s `StepRow` list (`:966-999` + `:631-663`): per-row enable checkbox + Up/Down/Remove (reuse `moveStep`/`removeStep`), and an add-`<select>` that **excludes already-added actions** (`actions.filter(a => !draft.actions.some(x => x.actionId === a.id))`); disable the Remove control when `draft.actions.length === 1`. Add a `name` `<input>`. List rendering (`:833-861`): show the N action names (join `actionNames`) and a "won't fire — all actions disabled" tag when `draft.actions.every(a => !a.enabled)`. Run display (`:883-892`) reads `TriggerRunResult`.
- `quickActions.tsx` (`:113-131`): manual-run result now `TriggerRunResult` → use the reshaped helpers.

- [ ] **Step 4: Run to verify it passes** — `bun test src/client/pages/settings/automation.test.ts` + `bun run typecheck` + `bun run build`. (No client component test harness — typecheck/build are the gates.)

- [ ] **Step 5: Commit**

```bash
git add src/client/pages/settings/automation.ts src/client/pages/settings/AutomationPage.tsx src/client/quickActions.tsx src/client/pages/settings/automation.test.ts
git commit -m "feat: trigger editor gains a name + ordered action list; N-result run display"
```

---

### Task 6: full switch — remove `actionId` from the trigger contract

**Files:**
- Modify: `src/shared/api.ts` (drop `actionId` from the 8 `AutomationTrigger` members)
- Modify: `src/server/automationTriggers.ts` (`rowToTrigger` stops emitting `actionId`; `normalize` stops returning it in the contract shape — the repo still WRITES the `action_id` column from `actions[0]`)
- Modify: `src/server/triggerDispatcher.ts` (any residual `trigger.actionId` reads — should be none after Task 4)
- Modify: every test still asserting `trigger.actionId` (see list below)
- Test: full `bun test`

**Interfaces:** `AutomationTrigger` no longer carries `actionId` (the DB column stays, written from `actions[0]`). `TriggerOverride.actionId` is unchanged (the override's own action).

- [ ] **Step 1: Write the failing check** — remove `actionId: string;` from one `AutomationTrigger` member and run `bun run typecheck`; the compile errors enumerate every remaining reader. (This is the "test" for a pure type-removal task.)

- [ ] **Step 2: Run to verify it fails** — `bun run typecheck` → errors at each `trigger.actionId` read.

- [ ] **Step 3: Implement** — drop `actionId` from all 8 members; remove `actionId: row.actionId,` from `rowToTrigger` and the `actionId:` key from `normalize`'s return object (keep `input.actions[0].actionId` feeding the `action_id` column in the write statements). Update every reader the compiler flags. Tests known to assert the single-action shape (update to `.actions`): `triggerDispatcher.test.ts`, `automationTriggers.test.ts`, `legacyMigration.test.ts`, `triggerOverrides.test.ts`, `redeemOnce.test.ts`, `viewerIdentity.test.ts`, `actionExecutor.test.ts` (only if it read a trigger's `actionId`), `automation.test.ts`. Leave `ActionRunResult.actionId` and `TriggerOverride.actionId` alone — those are not the trigger's field.

- [ ] **Step 4: Run to verify it passes** — `bun run typecheck` clean; `bun test` all green; `bun run build` clean.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: remove trigger.actionId from the contract (full switch to actions[])"
```

---

## Final verification

- [ ] `bun run typecheck` — clean
- [ ] `bun test` — all green (existing + new)
- [ ] `bun run build` — clean
- [ ] Manual smoke: create a trigger with two actions, fire it (manual/slash), confirm both run once and the run row rolls up; reorder/disable one action → dispatch reflects it; disable all → trigger flagged "won't fire" and does not fire; try to remove the last action → blocked. Confirm a pre-existing single-action trigger (post-migration) still fires exactly as before, and a seeded slash command (`/shoutout`) still works.

## Spec coverage self-check

| Spec section | Task |
|---|---|
| §2 join table + `name` + `action_id` kept | 1, 2 |
| §3 migration (guard + ledger reset + backfills) | 1 |
| §4 contract switch to `actions[]` + `TriggerRunResult` | 2 (additive), 6 (remove `actionId`) |
| §5 dispatch (one claim, N concurrent, roll-up, zero-enabled skip, override-replaces-list) | 4 |
| §6 editor (name, ordered list, ≥1, won't-fire flag) | 5 |
| §7 blast radius (repo, seeds/legacy, overrides, run consumers) | 2, 3, 4, 5, 6 |
| §8 testing (migration, dispatch, double-play, override, contract) | 1, 4, 6 |
