# Phase B2 — trigger conditions (an AND-only event filter)

**Status:** Approved (design). Implementation plan to follow.
**Date:** 2026-07-24
**Parent arc:** `2026-07-20-redis-automation-arc-design.md` §8 (Phase B, conditions half). B2 builds on B1 (multi-action triggers, merged). Independent of Redis and of Phase C/D.

---

## 1. Context & goal

A trigger fires whenever its source event matches (a reward id, a chat phrase, an event kind). B2 adds an optional **`conditions[]` filter**: a matched event only fires the trigger when **every** condition passes. This lets one reward/event drive different reactions ("cheer ≥ 100 → big alert", "sub tier 3 → special clip", "raid from a tagged friend → shoutout") without a separate trigger per case, and is the second half of the arc's Phase B.

**Decisions locked in this brainstorm (2026-07-24):**
- **Ops:** `eq / neq / contains / starts_with / gte / lte / in` on invocation-context scalars for every kind, **plus `role_is` / `tag_has` for chat kinds** (`chat_phrase`, `viewer_command`) where live badges/tags resolve. **No regex** (ReDoS on attacker-controlled chat), recorded in writing.
- **AND-only** semantics v1 (OR via multiple triggers).
- **Fail-closed:** a missing field makes a condition **false — including `neq`**; an unreadable `conditions_json` makes the trigger **not fire**.
- Text ops are **case-insensitive** (matching the existing phrase-match idiom).
- Conditions are gated by `enforceGates`, so a **manual test-run bypasses** them (like arming/cooldown).
- **One role vocabulary** end-to-end: `ViewerRole` = `broadcaster | mod | vip | sub` (fixes the existing `role`=`moderator` vs `mod` mismatch).

**Out of scope:** OR / nested boolean graphs; `{data.*}` inbound fields (Phase C); role/tag resolution for non-chat events (deferred — `role_is`/`tag_has` eval empty and never pass off the chat path, and the editor hides them there).

## 2. Contract (`shared/api.ts`)

```ts
export type ConditionOp =
  | 'eq' | 'neq' | 'contains' | 'starts_with' | 'gte' | 'lte' | 'in' | 'role_is' | 'tag_has';
export type TriggerCondition = { field: string; op: ConditionOp; value: string | number | string[] };
```
Every `AutomationTrigger` union member gains `conditions: TriggerCondition[]` (default `[]`). `AutomationTriggerInput` derives via `DistributiveOmit`. Additive — nothing is removed. `TriggerOverride` is untouched (an override substitutes the Action list; it does not re-evaluate conditions — the base trigger already matched + passed conditions before the override resolves, inside the single claim).

### 2.1 Field vocabulary (kind-aware)
`field` names a `TemplateContext` scalar. The valid set per kind (the editor offers only these):
| kind | fields |
|---|---|
| `reward` | `actor`, `login`, `input`, `rewardTitle` |
| `twitch_event` | `actor`, `login`, `amount`, `tier`, `months` |
| `chat_phrase` | `actor`, `login`, `message`, + `role_is`/`tag_has` |
| `viewer_command` | `actor`, `login`, `input`, `message`, + `role_is`/`tag_has` |
| `dashboard_slash` | `actor`, `login`, `input` |
| `manual` / `module_activate` / `module_deactivate` | `actor`, `login` (minimal) |

`role_is`/`tag_has` are ops whose `field` is fixed (`role` / `tags`); they read the resolved role-set / tag-set, not a context scalar.

## 3. Evaluator — `evaluateConditions` (pure)

A pure decision function (unit-tested like `evaluateWindDown`), lives in its own module (e.g. `src/server/triggerConditions.ts`):
```ts
export function evaluateConditions(
  conditions: TriggerCondition[],
  ctx: { fields: Record<string, string | number | undefined>; roles: readonly string[]; tags: readonly string[] },
): boolean
```
- **AND-only:** returns true iff every condition passes; `[]` → true (no filter).
- **Per-op** (case-insensitive for text):
  - `eq`/`neq`: string-equal the field to `value` (lowercased). `neq` on a **missing** field → **false** (fail-closed, stated explicitly).
  - `contains`/`starts_with`: substring / prefix (lowercased).
  - `gte`/`lte`: `Number(field)` vs `Number(value)`; either `NaN` → **false**.
  - `in`: the field (lowercased) is a member of `value` (a lowercased string[]).
  - `role_is`: `roles` includes `value` (a `ViewerRole`).
  - `tag_has`: `tags` includes `normalizeProfileTag(value)`.
- **Missing field → false** for every op (the field isn't in `ctx.fields`).
- The function is total and never throws; it treats an unknown `op` as false.

### 3.1 Fail-closed on an unreadable filter
`rowToTrigger` parses `conditions_json`. On a parse failure it logs and marks the trigger so the dispatcher **fails it closed** (never fires) — a corrupt filter on a moderation-capable trigger must not fire unconditionally. Mechanism: `rowToTrigger` sets `conditions` to a sentinel the dispatcher recognizes (e.g. a private `CONDITIONS_UNREADABLE` marker, or a `conditionsUnreadable: true` flag on the trigger object) and the invoke path returns `null` when it's set. Covered by a test that stores malformed JSON and asserts the trigger does not fire.

## 4. Dispatch (`triggerDispatcher.ts`)

Insert the check in `invoke()`, gated by `enforceGates`:
```
arming (isArmed)  →  conditions  →  skip-if-no-enabled-actions  →  cooldown  →  claim  →  run
```
- `if (enforceGates && !passesConditions(trigger, ctx)) return null;` — placed **after** `isArmed` and **before** the enabled-actions skip, so a non-matching event **claims no run row and consumes no cooldown** (a clean no-op; a later event that *would* match is not swallowed).
- **Manual runs bypass** (`enforceGates: false`) so the operator can test a conditioned trigger's actions.
- The dispatcher builds the condition context from the same `TemplateContext` it already assembles per source, plus a resolved `roles`/`tags` pair: chat paths already compute `getViewerRolesFromBadges(message.badges)` (for `passesRoleFilter`) and `getViewerTags(login)` — reuse them; non-chat paths pass empty `roles`/`tags` (so `role_is`/`tag_has` never pass there).
- `conditions` is already on the `AutomationTrigger` object (from `rowToTrigger`); no extra query.

## 5. Schema (`db.ts`)

- `automation_triggers.conditions_json TEXT NOT NULL DEFAULT '[]'` via `addColumnIfMissing` + entries in all three allowlists (`automation_triggers` already added in B1; add `conditions_json` to columns and `conditions_json: "text not null default '[]'"` to definitions).
- **No backfill** (existing triggers default to `[]` = no filter). **No self-healing guard** (a column, not a table).

## 6. `normalizeConditions` (write-time validation)

In `automationTriggers.ts`, mirroring `normalizeConfig`: parse `value.conditions` (array; default `[]`), validate each `{field, op, value}`:
- `op` ∈ `ConditionOp`.
- For comparison ops: `field` ∈ the kind's allowlist (§2.1); `gte`/`lte` `value` coerces to a finite number; `in` `value` is a non-empty string[]; else `value` is a string.
- `role_is`: `value` ∈ `ViewerRole`; only valid for chat kinds. `tag_has`: `value` normalizes to a non-empty tag via `normalizeProfileTag`; only valid for chat kinds.
- Cap at `MAX_CONDITIONS` (e.g. 10; mirror the `MAX_ALIASES`/`MAX_STEPS` limit idiom).
- Reject an invalid condition with `HttpRouteError(400, …)` (server is the authority; the client editor mirrors the limits).

## 7. Editor (`AutomationPage.tsx`, `automation.ts`)

A **conditions** section in the trigger form (below the actions list): add/remove condition rows; each row = a **field** dropdown (kind-aware, §2.1), an **op** dropdown (valid ops for that field/kind — `role_is`/`tag_has` only for chat kinds, numeric ops only for numeric fields), and a **typed value** input (text / number / a role dropdown for `role_is` / a tag input for `tag_has` / a comma list for `in`). `automation.ts` gains `MAX_CONDITIONS` and condition validation mirrored from the server. An empty conditions list is normal (no filter).

## 8. Testing strategy

- **`evaluateConditions` pure unit tests** (the correctness weight): every op; AND across multiple; `[]` → true; missing-field → false for **every** op incl. `neq`; `gte/lte` with `NaN` → false; `in` membership; `role_is`/`tag_has` against a roles/tags set and against empty (never pass); unknown op → false.
- **Fail-closed:** a trigger with malformed `conditions_json` does not fire (dispatcher + `rowToTrigger`).
- **Dispatch:** a non-matching event → **no `automation_runs` row and no cooldown consumed**; a matching event fires; a partially-matching AND fails; a **manual run bypasses** conditions and fires.
- **`normalizeConditions`:** per-op value-shape validation; kind-scoped field/op rejection; `role_is`/`tag_has` rejected on non-chat kinds; `MAX_CONDITIONS` cap; round-trips through create/update.
- **Contract/editor:** `conditions` persists + reads back; `automation.ts` validate.

## 9. Verification

`bun run typecheck`, `bun test`, `bun run build` all green. Smoke: add a `cheer` trigger with `amount gte 100`; a 50-bit cheer does nothing (no run row), a 150-bit cheer fires; a `viewer_command` with `role_is = sub` fires for a sub and not a non-sub; a manual test-run fires regardless; a pre-existing trigger (no conditions) fires exactly as before.
