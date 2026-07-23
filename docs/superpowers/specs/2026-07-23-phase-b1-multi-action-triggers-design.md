# Phase B1 — multi-action triggers (a trigger runs N ordered actions)

**Status:** Approved (design). Implementation plan to follow.
**Date:** 2026-07-23
**Parent arc:** `2026-07-20-redis-automation-arc-design.md` §8 (Phase B, the highest-blast-radius phase). Phase B is split into **B1 (multi-action, this doc)** and **B2 (conditions[], later)**; B1 is independent of Redis and of B2.

---

## 1. Context & goal

Today a trigger is strictly **1:1**: each `automation_triggers` row has one `action_id`, and the dispatcher claims one `automation_runs` dedupe key per `(trigger, event)` and runs that single Action. B1 makes a trigger run **N ordered actions concurrently**, and gives each trigger a `name`. This is the structural precondition for B2 (conditions) and for Phase C (inbound triggers running multiple safe steps).

**Decisions locked in this brainstorm (2026-07-23):**
- **Full switch to `actions[]`** — `AutomationTrigger` exposes `actions: TriggerAction[]` as the single runtime truth; `TriggerRunSummary` and `SlashCommandResponse.run` reshape to N results. The DB `action_id` column is **kept** as the re-derivable migration source but is no longer the contract shape.
- **Deleting the last action keeps the trigger, inert + flagged** (not delete). A zero-enabled-action trigger is skipped by the dispatcher (no claim, no cooldown) and flagged "no actions — won't fire" in the editor.
- **Execution is concurrent** (t0 model, `delayMs` relative to invocation start, mirroring `action_steps`); `position` is **display order only**.
- **Per-viewer override** replaces the enabled action list with `[overrideAction]` for that login.

**Out of scope (deferred to B2):** the `conditions_json` column, `evaluateConditions`, the dispatch-order condition step, and the conditions editor UI.

## 2. Schema

- **`automation_triggers.name TEXT`** — added via `addColumnIfMissing` + an `allowedMigrationColumns`/`allowedMigrationDefinitions` entry (`name: "text not null default ''"`). Backfilled by a **total** function to `"<kind> · <short-id>"` (e.g. `reward · a1b2c3`) — never empty.
- **`automation_trigger_actions(trigger_id, action_id, position, enabled)`** — new idempotent `create table if not exists`:
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
  The composite PK `(trigger_id, action_id)` is the **`UNIQUE`** that stops an action being listed twice on one trigger — which would double-play a clip with no redelivery, reopening the class `redeemOnce.test.ts` guards. On-delete-cascade on **both** FKs: deleting a trigger drops its rows; deleting an Action drops it from every trigger.
- **`automation_triggers.action_id` is kept intact** after migration (CLAUDE.md "legacy left intact"), so the join is always re-derivable.

## 3. Migration (the `bun --watch` + `runOnce` trap)

- Add `automation_triggers` to `allowedMigrationTables`; `name` to the column/definition allowlists.
- **Self-healing guard** modeled on `dropStaleTriggerOverrides`/`dropStaleLlmInteractions` (`db.ts`): if `automation_trigger_actions` exists but its shape is wrong (missing `position`/`enabled`, or an intermediate dev-server shape), **drop it** so the `create table` + `runOnce` copy rebuild it from `action_id`. This runs at load, **before** the `runOnce` copy — because a `bun --watch` reload that persisted a half-built table would otherwise burn the `runOnce` ledger id and skip the corrected migration forever.
- **`runOnce('backfill-trigger-actions', …)`** copy: for every `automation_triggers` row, insert one `automation_trigger_actions(trigger_id, action_id, position=0, enabled=1)`. Re-derivable from the retained `action_id`, not a bare one-shot.
- **`name` backfill:** a total function fills every existing trigger's `name` (also idempotent-safe: only fill where empty).
- Verified in a `*.test.ts` against the in-memory DB (`NODE_ENV=test`) — never an ad-hoc script against the live DB (the import-hoist hazard).

## 4. Contract (`shared/api.ts`) — full switch

```ts
export type TriggerAction = { actionId: string; position: number; enabled: boolean };
```
- Every `AutomationTrigger` union member: **drop `actionId`**, add `name: string` and `actions: TriggerAction[]`.
- `AutomationTriggerInput` (via `DistributiveOmit`) carries `name` + `actions`.
- `TriggerRunSummary`: `{ triggerId: string; status: ActionRunStatus; actions: ActionRunResult[] }` (was `{ triggerId, actionId, result }`). `ActionRunStatus` = `'succeeded' | 'partial' | 'failed' | 'skipped'` (reused).
- `SlashCommandResponse.run`: `{ status: ActionRunStatus; actions: ActionRunResult[] } | null` (was a single `ActionRunResult | null`). The dashboard slash-result consumer renders N results with the rolled-up status.

## 5. Dispatch (`triggerDispatcher.ts`)

- `invoke` still claims **exactly one** `automation_runs` row per `(trigger, event)` (one `insertRun` with `dedupe_key = trigger.id:eventId`, one `finishRun`). **A per-action loop that claims per action is forbidden** — the second would collide on the dedupe unique index and silently no-op.
- After the claim, load the trigger's **enabled** actions ordered by `position`, run them **concurrently** (each an existing `runAction(actionId, context)` — t0 model), collect N `ActionRunResult`s, and **roll up** to one `ActionRunStatus`. Rule (skipped actions are no-ops that broadcast nothing, so they never drag a working trigger down):
  - all ran actions `skipped` → `skipped`;
  - else any `failed`/`partial` mixed with any non-failed (succeeded or skipped) → `partial`;
  - else all `failed` → `failed`;
  - else (all `succeeded`, or `succeeded` + `skipped`) → `succeeded`.
  - A per-action failure never aborts the others. One `finishRun` writes the rolled-up status + a detail summarising the N results.
- **Zero enabled actions → skip the claim entirely** — no run row inserted, no cooldown/dedup consumed (the inert-trigger behavior). This check runs **before** the cooldown gate and `insertRun`.
- **Order preserved:** arming → source/config match → **skip-if-no-enabled-actions** → cooldown → claim → run. (B2 inserts a `conditions` step between config-match and the no-actions check.)
- **Per-viewer override:** resolve the override inside `invoke` (as today) but substitute the whole enabled action list with `[{ actionId: overrideActionId, position: 0, enabled: true }]` for that login. The base trigger still matches once, claims one dedupe key, and owns the cooldowns → a double alert stays structurally impossible. A `skipped` override run falls back to the base action list under the **same** run row (safe: a skipped run broadcasts nothing); `partial`/`failed` do not fall back.

## 6. Editor (`AutomationPage.tsx`, `automation.ts`)

- Trigger editor gains a **`name`** input and an **ordered action list**: add / remove / reorder (position) / enable-toggle per action, replacing the single action picker.
- Enforce the UNIQUE client-side (the "add action" picker excludes actions already on the trigger) and server-side (the PK rejects a dupe).
- A trigger with zero enabled actions renders a **"no actions — won't fire"** flag (the same treatment idiom as the existing trigger warnings).
- `automation.ts` (React-free limits/validation) gains action-list limits and the normalize rules.

## 7. Blast radius — every producer/consumer to update

- `automationTriggers.ts` — the union/Input, `normalizeAutomationTriggerInput` (validate `actions[]`: each `actionId` resolves, unique, positions normalized; `name` non-empty), the row mapper (join actions in), the CRUD routes (write the join table transactionally).
- `triggerDispatcher.ts` + `automation.ts` — `invoke`/`invokeAll`, the `runAction` port usage, the run summary shape.
- `SlashCommandResponse.run` — the `/api/automation/slash` route and the dashboard slash-result consumer.
- `triggerOverrides.ts` — the override substitution now replaces the list.
- Seeded slash commands / legacy conversions (`migrateQuackCommandIntoAction`, `automationTriggers.ts` seeds, `legacyMigration.ts`) that create a trigger with one action → now `actions: [one]`.

## 8. Testing strategy

- **Migration** (`*.test.ts`, in-memory): every existing 1:1 trigger yields exactly one join row (`position=0`, `enabled=1`); `name` backfilled non-empty; re-run idempotent (no duplicate join rows); the self-healing guard drops-and-rebuilds a shape-broken table.
- **Dispatch:** N enabled actions all run (concurrently); exactly **one** `automation_runs` claim and one `finishRun`; roll-up status across succeeded/partial/failed/skipped mixes; **zero enabled actions → no claim** (assert no run row and cooldown not consumed); disabled actions are skipped.
- **Double-play guard:** extend `redeemOnce.test.ts` — the PK rejects listing one action twice on a trigger; a redelivered multi-action trigger still claims one dedupe key and does not replay.
- **Override:** replace-with-`[override]`, exactly-once claim, `skipped` override → fallback to the base list under the same run row.
- **Contract:** `TriggerRunSummary`/`SlashCommandResponse.run` carry N results with the correct rolled-up status; the dashboard consumer renders them.

## 9. Verification

`bun run typecheck`, `bun test`, `bun run build` all green. Smoke: create a trigger with two actions, fire it (manual/slash), confirm both run once and the run row rolls up correctly; delete one action → trigger still fires the other; delete the last → trigger flagged inert and does not fire. Confirm an existing single-action trigger (post-migration) still fires exactly as before.
