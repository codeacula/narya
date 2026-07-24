# Phase B2 — Trigger Conditions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A trigger gains an optional **`conditions: TriggerCondition[]`** AND-only filter; a matched event only fires when every condition passes, evaluated after arming and **before** the claim so a non-matching event consumes no run row or cooldown.

**Architecture:** A pure `evaluateConditions(conditions, context)` (a `evaluateWindDown`-style decision, in a new `triggerConditions.ts`) reads the `TemplateContext` the dispatcher already builds (extended with a resolved `roles`). The contract gains `conditions[]` additively; the dispatcher inserts one gate in `invoke()`; the repo validates at write time and fail-closes an unreadable `conditions_json` via a shared sentinel; the editor gains a kind-aware conditions section.

**Tech Stack:** Bun + TypeScript, Express, `bun:sqlite` (`db.ts`), React (client), `bun test`.

## Global Constraints

- **AND-only:** all conditions must pass; `[]` → fires (no filter). No OR/nesting.
- **No regex** (ReDoS on attacker-controlled chat) — ops are `eq/neq/contains/starts_with/gte/lte/in/role_is/tag_has` only.
- **Fail-closed:** a missing field makes a condition **false for every op, including `neq`**; an **unreadable `conditions_json` makes the trigger not fire** (a corrupt filter must never fire unconditionally).
- Text ops (`eq/neq/contains/starts_with/in`) are **case-insensitive**. `gte/lte` coerce both sides with `Number()`; either `NaN` → false. `evaluateConditions` is **total (never throws)**; an unknown op → false.
- **One role vocabulary:** `ViewerRole = 'broadcaster'|'mod'|'vip'|'sub'` (`getViewerRolesFromBadges`); `role_is`/`tag_has` resolve **only for chat kinds** (empty elsewhere → never pass).
- **Manual runs bypass conditions** (the gate is under `enforceGates`, like arming/cooldown).
- **Dispatch order:** `arming → conditions → skip-if-no-enabled-actions → cooldown → claim → run`. A non-matching event returns `null` before any claim/cooldown.
- Additive contract (no removal). Column via `addColumnIfMissing` + all three allowlists; **no backfill** (default `'[]'`), **no self-healing guard**. Verify per task with `bun run typecheck` + the covering test; full `bun test` + `bun run build` at the end.

---

### Task 1: pure `evaluateConditions` + contract types + schema column

**Files:**
- Modify: `src/shared/api.ts` (`ConditionOp`, `TriggerCondition`; `TemplateContext += roles?: ViewerRole[]`)
- Create: `src/server/triggerConditions.ts` (`evaluateConditions`, `CONDITIONS_UNREADABLE`)
- Modify: `src/server/db.ts` (`conditions_json` column + allowlists)
- Test: `src/server/triggerConditions.test.ts` (new)

**Interfaces:**
- Produces: `ConditionOp`, `TriggerCondition = { field: string; op: ConditionOp; value: string | number | string[] }`; `evaluateConditions(conditions: TriggerCondition[], context: TemplateContext): boolean`; `CONDITIONS_UNREADABLE: TriggerCondition[]` (a frozen sentinel array — reference-compared, makes `evaluateConditions` return false); column `automation_triggers.conditions_json TEXT NOT NULL DEFAULT '[]'`.

- [ ] **Step 1: Write the failing test** — `src/server/triggerConditions.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { CONDITIONS_UNREADABLE, evaluateConditions } from './triggerConditions';
import type { TemplateContext, TriggerCondition } from '../shared/api';

const ctx = (over: Partial<TemplateContext>): TemplateContext => over;

describe('evaluateConditions', () => {
  test('empty conditions always pass', () => {
    expect(evaluateConditions([], ctx({}))).toBe(true);
  });
  test('eq / contains / starts_with are case-insensitive', () => {
    expect(evaluateConditions([{ field: 'actor', op: 'eq', value: 'Bob' }], ctx({ actor: 'bob' }))).toBe(true);
    expect(evaluateConditions([{ field: 'message', op: 'contains', value: 'HELLO' }], ctx({ message: 'oh hello there' }))).toBe(true);
    expect(evaluateConditions([{ field: 'input', op: 'starts_with', value: '!go' }], ctx({ input: '!GO now' }))).toBe(true);
  });
  test('gte / lte coerce; NaN → false', () => {
    expect(evaluateConditions([{ field: 'amount', op: 'gte', value: 100 }], ctx({ amount: 150 }))).toBe(true);
    expect(evaluateConditions([{ field: 'amount', op: 'gte', value: 100 }], ctx({ amount: 50 }))).toBe(false);
    expect(evaluateConditions([{ field: 'tier', op: 'gte', value: 2 }], ctx({ tier: 'notanumber' }))).toBe(false);
  });
  test('in membership (case-insensitive)', () => {
    expect(evaluateConditions([{ field: 'tier', op: 'in', value: ['1000', '3000'] }], ctx({ tier: '3000' }))).toBe(true);
    expect(evaluateConditions([{ field: 'tier', op: 'in', value: ['1000'] }], ctx({ tier: '3000' }))).toBe(false);
  });
  test('AND across multiple; one failure fails all', () => {
    expect(evaluateConditions([{ field: 'amount', op: 'gte', value: 100 }, { field: 'actor', op: 'eq', value: 'bob' }], ctx({ amount: 150, actor: 'bob' }))).toBe(true);
    expect(evaluateConditions([{ field: 'amount', op: 'gte', value: 100 }, { field: 'actor', op: 'eq', value: 'bob' }], ctx({ amount: 150, actor: 'ann' }))).toBe(false);
  });
  test('missing field → false for EVERY op, including neq', () => {
    for (const op of ['eq', 'neq', 'contains', 'starts_with', 'gte', 'lte', 'in'] as const) {
      const value = op === 'in' ? ['x'] : op === 'gte' || op === 'lte' ? 1 : 'x';
      expect(evaluateConditions([{ field: 'amount', op, value }], ctx({}))).toBe(false);
    }
  });
  test('role_is / tag_has read the resolved sets; empty → never pass', () => {
    expect(evaluateConditions([{ field: 'role', op: 'role_is', value: 'sub' }], ctx({ roles: ['sub', 'vip'] }))).toBe(true);
    expect(evaluateConditions([{ field: 'role', op: 'role_is', value: 'mod' }], ctx({ roles: ['sub'] }))).toBe(false);
    expect(evaluateConditions([{ field: 'role', op: 'role_is', value: 'sub' }], ctx({}))).toBe(false);
    expect(evaluateConditions([{ field: 'tags', op: 'tag_has', value: 'Friend' }], ctx({ tags: ['friend'] }))).toBe(true); // normalized
  });
  test('the unreadable sentinel fails closed', () => {
    expect(evaluateConditions(CONDITIONS_UNREADABLE, ctx({ actor: 'bob' }))).toBe(false);
  });
  test('unknown op → false', () => {
    expect(evaluateConditions([{ field: 'actor', op: 'wat' as never, value: 'x' }], ctx({ actor: 'x' }))).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `bun test src/server/triggerConditions.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement**

`src/shared/api.ts`:
```ts
export type ConditionOp = 'eq' | 'neq' | 'contains' | 'starts_with' | 'gte' | 'lte' | 'in' | 'role_is' | 'tag_has';
export type TriggerCondition = { field: string; op: ConditionOp; value: string | number | string[] };
```
Add `roles?: ViewerRole[];` to `TemplateContext` (import `ViewerRole` from `./roles`; comment: set by the chat dispatcher for `role_is`, absent elsewhere). Keep the existing `role?`/`tags?`.

`src/server/triggerConditions.ts`:
```ts
import type { TemplateContext, TriggerCondition } from '../shared/api';
import { normalizeProfileTag } from '../shared/viewerTags';

/** A conditions array whose JSON could not be parsed. Reference-compared; makes the
 *  trigger fail closed (never fire) rather than firing with no filter. */
export const CONDITIONS_UNREADABLE: TriggerCondition[] = Object.freeze([]) as TriggerCondition[];

const lc = (v: unknown): string => String(v ?? '').toLowerCase();

function fieldValue(context: TemplateContext, field: string): unknown {
  return (context as Record<string, unknown>)[field];
}

function passes(condition: TriggerCondition, context: TemplateContext): boolean {
  const { field, op, value } = condition;
  if (op === 'role_is') return (context.roles ?? []).includes(value as never);
  if (op === 'tag_has') return (context.tags ?? []).map(normalizeProfileTag).includes(normalizeProfileTag(String(value)));

  const raw = fieldValue(context, field);
  if (raw === undefined || raw === null) return false; // missing field → false, incl. neq

  switch (op) {
    case 'eq': return lc(raw) === lc(value);
    case 'neq': return lc(raw) !== lc(value);
    case 'contains': return lc(raw).includes(lc(value));
    case 'starts_with': return lc(raw).startsWith(lc(value));
    case 'gte': { const a = Number(raw), b = Number(value); return !Number.isNaN(a) && !Number.isNaN(b) && a >= b; }
    case 'lte': { const a = Number(raw), b = Number(value); return !Number.isNaN(a) && !Number.isNaN(b) && a <= b; }
    case 'in': return Array.isArray(value) && value.map(lc).includes(lc(raw));
    default: return false;
  }
}

export function evaluateConditions(conditions: TriggerCondition[], context: TemplateContext): boolean {
  if (conditions === CONDITIONS_UNREADABLE) return false;
  return conditions.every(condition => passes(condition, context));
}
```

`src/server/db.ts`: add `'conditions_json'` to `allowedMigrationColumns`, `conditions_json: "text not null default '[]'"` to `allowedMigrationDefinitions`, and `addColumnIfMissing('automation_triggers', 'conditions_json', "text not null default '[]'");` in the migration run (`automation_triggers` is already in `allowedMigrationTables` from B1).

- [ ] **Step 4: Run to verify it passes** — `bun test src/server/triggerConditions.test.ts` + `bun run typecheck` → PASS/clean.

- [ ] **Step 5: Commit**

```bash
git add src/shared/api.ts src/server/triggerConditions.ts src/server/db.ts src/server/triggerConditions.test.ts
git commit -m "feat: pure evaluateConditions + condition types + conditions_json column"
```

---

### Task 2: contract union + repo (`normalizeConditions`, read/write `conditions_json`)

**Files:**
- Modify: `src/shared/api.ts` (`conditions: TriggerCondition[]` on all 8 `AutomationTrigger` members)
- Modify: `src/server/automationTriggers.ts` (Row/columns/statements + `conditions_json`; `normalizeConditions`; `rowToTrigger` parse + sentinel; write)
- Test: `src/server/automationTriggers.test.ts` (extend)

**Interfaces:**
- Consumes: `TriggerCondition`, `CONDITIONS_UNREADABLE` (Task 1).
- Produces: every `AutomationTrigger` carries `conditions: TriggerCondition[]`; `MAX_CONDITIONS = 10` (server); the repo persists/reads `conditions_json`; `rowToTrigger` yields `CONDITIONS_UNREADABLE` on a parse failure; write-time validation via `normalizeConditions`.

- [ ] **Step 1: Write the failing test** — extend `automationTriggers.test.ts`:

```ts
test('conditions persist and read back; invalid ones are rejected', () => {
  const t = createAutomationTrigger({ kind: 'twitch_event', name: 'big cheer', moduleId: null, enabled: true,
    globalCooldownMs: 0, userCooldownMs: 0, config: { eventKind: 'cheer' },
    actions: [{ actionId: act1, position: 0, enabled: true }],
    conditions: [{ field: 'amount', op: 'gte', value: 100 }] });
  expect(t.conditions).toEqual([{ field: 'amount', op: 'gte', value: 100 }]);
  // unknown field / op rejected
  expect(() => createAutomationTrigger({ /* … */ conditions: [{ field: 'nope', op: 'eq', value: 'x' }] })).toThrow();
  // role_is only valid on chat kinds
  expect(() => createAutomationTrigger({ kind: 'reward', /* … */ conditions: [{ field: 'role', op: 'role_is', value: 'sub' }] })).toThrow();
});

test('a trigger with unreadable conditions_json reads back the fail-closed sentinel', () => {
  const t = createAutomationTrigger({ /* a valid trigger */ });
  db.prepare('update automation_triggers set conditions_json = ? where id = ?').run('{bad json', t.id);
  expect(getAutomationTrigger(t.id)!.conditions).toBe(CONDITIONS_UNREADABLE);
});
```

- [ ] **Step 2: Run to verify it fails** — `bun test src/server/automationTriggers.test.ts` → FAIL.

- [ ] **Step 3: Implement**
- `src/shared/api.ts`: add `conditions: TriggerCondition[];` to every `AutomationTrigger` member (additive; `AutomationTriggerInput` derives).
- `automationTriggers.ts`: `MAX_CONDITIONS = 10` (const, mirror `MAX_ALIASES`). Add `conditionsJson` to `TriggerRow`, `conditions_json as conditionsJson` to `TRIGGER_COLUMNS`, and `conditions_json` to the insert/update SQL + `.run(...)` args (write `JSON.stringify(input.conditions)`).
- `normalizeConditions(kind, value): TriggerCondition[]`:
```ts
const CHAT_KINDS = new Set<AutomationTriggerKind>(['chat_phrase', 'viewer_command']);
// Comparison-op fields per kind (role_is/tag_has use field 'role'/'tags' and are gated separately).
const CONDITION_FIELDS: Record<AutomationTriggerKind, Set<string>> = {
  reward: new Set(['actor', 'login', 'input', 'rewardTitle']),
  twitch_event: new Set(['actor', 'login', 'amount', 'tier', 'months']),
  chat_phrase: new Set(['actor', 'login', 'message']),
  viewer_command: new Set(['actor', 'login', 'input', 'message']),
  dashboard_slash: new Set(['actor', 'login', 'input']),
  manual: new Set(['actor', 'login']),
  module_activate: new Set(['actor', 'login']),
  module_deactivate: new Set(['actor', 'login']),
};
const COMPARISON_OPS = new Set(['eq','neq','contains','starts_with','gte','lte','in']);

function normalizeConditions(kind: AutomationTriggerKind, value: unknown): TriggerCondition[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new HttpRouteError(400, 'conditions must be an array.');
  if (value.length > MAX_CONDITIONS) throw new HttpRouteError(400, `A trigger can have at most ${MAX_CONDITIONS} conditions.`);
  return value.map(raw => {
    const c = asRecord(raw);
    const op = c.op as ConditionOp;
    if (op === 'role_is' || op === 'tag_has') {
      if (!CHAT_KINDS.has(kind)) throw new HttpRouteError(400, `${op} is only available on chat triggers.`);
      if (op === 'role_is' && !['broadcaster','mod','vip','sub'].includes(String(c.value))) throw new HttpRouteError(400, 'role_is needs a valid role.');
      if (op === 'tag_has' && !normalizeProfileTag(String(c.value ?? ''))) throw new HttpRouteError(400, 'tag_has needs a tag.');
      return { field: op === 'role_is' ? 'role' : 'tags', op, value: String(c.value) };
    }
    if (!COMPARISON_OPS.has(String(c.op))) throw new HttpRouteError(400, `Unsupported condition op: ${c.op}.`);
    const field = typeof c.field === 'string' ? c.field : '';
    if (!CONDITION_FIELDS[kind]?.has(field)) throw new HttpRouteError(400, `Field "${field}" is not available on a ${kind} trigger.`);
    if (op === 'in') { if (!Array.isArray(c.value) || c.value.length === 0) throw new HttpRouteError(400, 'in needs a non-empty list.'); return { field, op, value: c.value.map(String) }; }
    if (op === 'gte' || op === 'lte') { const n = Number(c.value); if (Number.isNaN(n)) throw new HttpRouteError(400, `${op} needs a number.`); return { field, op, value: n }; }
    return { field, op, value: String(c.value ?? '') };
  });
}
```
  Import `normalizeProfileTag` (`../shared/viewerTags`) and the condition types. Call it in `normalizeAutomationTriggerInput` (return `conditions: normalizeConditions(kind, value.conditions)`).
- `rowToTrigger`: parse `conditions_json` in a try/catch mirroring the config parse; on failure `console.error` + set `conditions = CONDITIONS_UNREADABLE`; else the parsed array. Return `conditions` on the object.

- [ ] **Step 4: Run to verify it passes** — `bun test src/server/automationTriggers.test.ts` + `bun run typecheck` (fix fixture ripple: constructions of `AutomationTriggerInput` in tests/editor now need `conditions: []`).

- [ ] **Step 5: Commit**

```bash
git add src/shared/api.ts src/server/automationTriggers.ts src/server/automationTriggers.test.ts
git commit -m "feat: triggers persist validated conditions[] (fail-closed on unreadable JSON)"
```

---

### Task 3: dispatcher applies conditions

**Files:**
- Modify: `src/server/triggerDispatcher.ts` (the `invoke()` gate + the chat builder's `roles`)
- Test: `src/server/triggerDispatcher.test.ts` (extend)

**Interfaces:** consumes `evaluateConditions` (Task 1), `trigger.conditions` (Task 2).

- [ ] **Step 1: Write the failing test** — in `triggerDispatcher.test.ts`:

```ts
test('a non-matching condition fires nothing (no run row, no cooldown consumed)', async () => {
  // twitch_event 'cheer' trigger with conditions [{amount gte 100}]; dispatch a 50-bit cheer
  await dispatcher.handleTwitchEvent({ kind: 'cheer', eventId: 'e1', actor: 'bob', login: 'bob', amount: 50 });
  expect(runCalls).toHaveLength(0);
  expect(db.prepare('select count(*) as n from automation_runs where trigger_id = ?').get(triggerId)).toEqual({ n: 0 });
});
test('a matching condition fires', async () => {
  await dispatcher.handleTwitchEvent({ kind: 'cheer', eventId: 'e2', actor: 'bob', login: 'bob', amount: 150 });
  expect(runCalls.length).toBeGreaterThan(0);
});
test('role_is fires for a sub in chat and not a non-sub', async () => {
  // viewer_command trigger with [{role_is sub}]; dispatch a !cmd from a sub (badges) then a non-sub
  // assert fired once
});
test('a manual run bypasses conditions', async () => {
  const result = await dispatcher.runTriggerManually(triggerId); // conditions would fail with empty context
  expect(result.status).not.toBe('skipped'); // it ran
});
test('unreadable conditions_json fails closed (does not fire)', async () => {
  // store bad json on a matching trigger; dispatch the matching event; assert no run
});
```

- [ ] **Step 2: Run to verify it fails** — no gate yet → the non-matching cheer fires → FAIL.

- [ ] **Step 3: Implement**
- Add near the top of `invoke()`, immediately after `if (enforceGates && !isArmed(trigger)) return null;`:
```ts
if (enforceGates && !evaluateConditions(trigger.conditions, context)) return null;
```
  (`evaluateConditions` returns false for `CONDITIONS_UNREADABLE`, so the fail-closed case is handled here too. Manual runs skip it via `enforceGates`.) Import `evaluateConditions` from `./triggerConditions`.
- In the chat builder, add `roles: getViewerRolesFromBadges(message.badges)` to both the `chat_phrase` and `viewer_command` `context` objects (`getViewerRolesFromBadges` is already imported). Leave other source builders' contexts without `roles` (so `role_is` never passes off chat).

- [ ] **Step 4: Run to verify it passes** — `bun test src/server/triggerDispatcher.test.ts` + `bun run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add src/server/triggerDispatcher.ts src/server/triggerDispatcher.test.ts
git commit -m "feat: dispatcher gates on conditions before claim; chat resolves roles"
```

---

### Task 4: editor — a kind-aware conditions section

**Files:**
- Modify: `src/client/pages/settings/automation.ts` (`MAX_CONDITIONS`, condition validation, the field/op vocabulary per kind, `newTrigger`/`triggerToInput` carry `conditions`)
- Modify: `src/client/pages/settings/AutomationPage.tsx` (a conditions editor section)
- Test: `src/client/pages/settings/automation.test.ts` (extend)

**Interfaces:** consumes `TriggerCondition`/`ConditionOp` (Task 1), `AutomationTrigger.conditions` (Task 2).

- [ ] **Step 1: Write the failing test** — in `automation.test.ts`: `newTrigger` seeds `conditions: []`; `triggerToInput` round-trips `conditions`; a client `validateConditions` (or `validateTrigger`) rejects a `gte` with a non-numeric value and a `role_is` on a non-chat kind, mirroring the server.

- [ ] **Step 2: Run to verify it fails** — the client has no `conditions` handling → FAIL.

- [ ] **Step 3: Implement**
- `automation.ts`: `MAX_CONDITIONS = 10` (mirror the server); a `CONDITION_FIELDS_BY_KIND` map + `OPS_BY_FIELD` helper (numeric fields → numeric ops; chat kinds → role_is/tag_has); a `validateConditions(kind, conditions)` used inside `validateTrigger`. `newTrigger` base gains `conditions: []`; `triggerToInput` already spreads `...trigger` so `conditions` rides through.
- `AutomationPage.tsx`: below the actions list in `TriggerEditor`, add a **Conditions** section: a list of condition rows (each a field `<select>` [kind-aware], an op `<select>` [valid for the field], and a value input typed by op — text / number / a role `<select>` for `role_is` / a tag input for `tag_has` / a comma-separated list for `in`), an add-row control (disabled at `MAX_CONDITIONS`), and a per-row Remove. Reuse the generic `moveStep`/`removeStep`-style array helpers or a simple index map/filter. An empty list is valid (no filter) — no "won't fire" implication.

- [ ] **Step 4: Run to verify it passes** — `bun test src/client/pages/settings/automation.test.ts` + `bun run typecheck` + `bun run build`. (No component harness — typecheck/build + automation.test.ts are the gates.)

- [ ] **Step 5: Commit**

```bash
git add src/client/pages/settings/automation.ts src/client/pages/settings/AutomationPage.tsx src/client/pages/settings/automation.test.ts
git commit -m "feat: trigger editor gains a kind-aware conditions section"
```

---

## Final verification

- [ ] `bun run typecheck` — clean
- [ ] `bun test` — all green
- [ ] `bun run build` — clean
- [ ] Manual smoke: a `cheer` trigger with `amount gte 100` — a 50-bit cheer records no run row, a 150-bit cheer fires; a `viewer_command` with `role_is = sub` fires for a sub and not a non-sub; a manual test-run fires regardless of conditions; a pre-existing trigger (no conditions) fires exactly as before; a trigger whose `conditions_json` is corrupted does not fire.

## Spec coverage self-check

| Spec section | Task |
|---|---|
| §2 contract (ConditionOp/TriggerCondition/conditions[]) | 1, 2 |
| §2.1 kind-aware field vocabulary | 2 (validate), 4 (editor) |
| §3 pure evaluateConditions + all ops + fail-closed | 1 |
| §3.1 unreadable-json sentinel | 1 (sentinel), 2 (rowToTrigger), 3 (dispatch) |
| §4 dispatch gate + manual bypass + roles resolution | 3 |
| §5 schema column | 1 |
| §6 normalizeConditions | 2 |
| §7 editor | 4 |
| §8 testing | 1–4 |
