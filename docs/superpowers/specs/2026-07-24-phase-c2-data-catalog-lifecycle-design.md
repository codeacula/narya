# Phase C2 — data-key catalog + lifecycle coupling

**Status:** Approved (design). Implementation plan to follow.
**Date:** 2026-07-24
**Parent arc:** `2026-07-20-redis-automation-arc-design.md` §9 (Phase C, lifecycle half). C2 builds on C1 (inbound Redis triggers, merged 2026-07-24, merge commit `a4667eb`). Independent of Phase D.

---

## 1. Context & goal

C1 shipped the inbound path: a registered app `XADD`s events onto its per-app stream, Narya consumes them (gated, poison-isolated, at-least-once) and fires operator-authored `redis_event` triggers, restricted to a run-time safe-step allowlist. C1 declares event **names** only; `app_events.data_schema_json` exists but is an unused `'{}'` placeholder, and `{data.*}` is typed blind.

C2 turns `data_schema_json` into a **live, auto-learned, typed data-key catalog** per declared event, uses it to make `{data.*}` **pickable and type-validated in the conditions editor**, and adds **lifecycle coupling** — a `redis_event` trigger bound to a de-registered event (or a disabled app) is **flagged inert in the editor** rather than silently dropped.

**Decisions locked in this brainstorm (2026-07-24):**
- **Catalog population: auto-learn from live events.** The consumer records each new/changed data key it observes; no hand-declaration of keys. (The event NAME is still operator-declared — the C1 registration gate is unchanged.)
- **Per-key metadata: name + inferred type** (`string` / `number` / `boolean`), reusing B2's type-aware condition machinery.
- **De-registration: allow removal, flag bound triggers inert** (not block). Removal succeeds; the automation editor surfaces the inert state.

**Out of scope:** hard-validating `{data.*}` in Action step templates (Actions are reusable across triggers and non-redis kinds — validating one Action against one event is unsound; templates get an *advisory* reference only). Blocking de-registration. Nested/dotted data paths (flat top-level keys only, matching C1's `{data.*}` semantics). The app **token** (Phase D). No change to the safe-step allowlist or the registration gate.

## 2. Contract (`shared/api.ts`)

```ts
export type AppEventDataKeyType = 'string' | 'number' | 'boolean';
export type AppEventDataKey = { name: string; type: AppEventDataKeyType };
```
`AppEvent` gains **`dataKeys: AppEventDataKey[]`** — the parsed, name-sorted view of `data_schema_json`, produced by the server when mapping the row. The raw `dataSchemaJson` string stays a server storage detail and is **dropped from the wire**: it is currently declared on `AppEvent` (`shared/api.ts`) and selected in `apps.ts`'s `EVENT_COLUMNS`, but has **no client consumer** (verified — no reference outside `api.ts`/`db.ts`/`apps.ts`), so replacing it is safe. `dataKeys` is `[]` for an event with an empty (`'{}'`) catalog.

`data_schema_json` storage shape (server-internal): a **flat JSON object** `{ [dataKey: string]: AppEventDataKeyType }`. `'{}'` = no keys yet. No wrapper object (YAGNI); if event-level metadata is ever needed, migrate then.

## 3. Type inference + catalog merge (pure core)

Two pure functions (unit-tested, no DB/Redis) in a new module `src/server/appEventCatalog.ts`:

```ts
export function inferKeyType(value: unknown): AppEventDataKeyType | null;
export function mergeDataCatalog(
  stored: Record<string, AppEventDataKeyType>,
  data: Record<string, unknown>,
): { catalog: Record<string, AppEventDataKeyType>; changed: boolean };
```
- **`inferKeyType`:** `string`→`string`, `number` (finite)→`number`, `boolean`→`boolean`; a non-scalar (object/array) → `string` (it renders as a capped JSON string via C1's `{data.*}` coercion, so `string` is the honest editor hint); `null`/`undefined`/non-finite number → `null` (skip — not recorded).
- **`mergeDataCatalog`:** iterate `data`'s **top-level** keys; for each with a non-null inferred type, add it or update its type if different (**last-observed type wins**); keys already stored and unchanged are left as-is; keys absent from `data` are **retained** (the catalog is cumulative — an event that sometimes omits a key must not lose it). Returns the merged catalog and a `changed` flag true iff a key was added or a type changed. `changed: false` when `data` introduces nothing new — the caller then skips the write.
- Total and never throws; a malformed `stored` (defensive) is treated as `{}`.

## 4. Auto-learn wiring (the consumer)

In `redisInbound.ts`, after a `dispatch` decision is **dispatched and XACKed**, best-effort record the catalog:
- Call a repo `recordDataKeys(appId, eventName, data)` that reads the stored `data_schema_json` for `(appId, eventName)`, runs `mergeDataCatalog`, and `UPDATE`s the row **only when `changed`**. Once the schema converges this is a read-only no-op per entry.
- **Best-effort:** wrap in try/catch; a learn failure is logged (message only) and swallowed. It must never stall the loop, delay a fire, or affect XACK. It runs after XACK so it can never delay delivery.
- Only a **dispatched** (declared, well-formed, in-bounds) entry learns — a dropped entry (undeclared/oversized/poison) never touches the catalog. Reserved keys (`actor`/`login`) present in `data` are recorded like any other key (they are real, usable as `{data.actor}` too).
- The learn reads the **coerced** `data` object the decision core already produced (a non-object `data` is `{}` — nothing to learn).

## 5. Conditions editor — `{data.*}` fields (pickable + type-aware)

**Server — two surgical changes, and NO dispatcher change.**

Verified against the repo: `evaluateConditions(trigger.conditions, context)` reads fields via `fieldValue(context, field)` = `(context as Record<string, unknown>)[field]` — a **flat** property lookup. C1 already places the payload on the context as a nested `context.data` object, so a `data.boss` condition would today read `context['data.boss']` → `undefined` → fail closed. The fix belongs in the pure evaluator, not in a context-flattening step in the dispatcher:

- **`triggerConditions.ts` `fieldValue` gains a `data.` branch:** when `field` matches `/^data\.(.+)$/`, read `context.data?.[key]` instead of the flat property. Non-scalar values coerce to the same capped-JSON string form `{data.*}` renders (so a condition and a template agree, and `contains` on an object never compares against `[object Object]`). Everything else in `passes`/`evaluateConditions` is untouched — missing key → `undefined` → false for every op incl. `neq` (B2 fail-closed semantics preserved). **The dispatcher needs no change at all**, since `handleRedisEvent` already sets `context.data`.
- **`automationTriggers.ts` `normalizeConditions`** (the `CONDITION_FIELDS[kind]?.has(field)` gate) accepts, for `redis_event` only, a `data.<key>` field matching `/^data\.[A-Za-z0-9_.-]+$/` in addition to the existing `actor`/`login` set. `data.*` fields are validated **by pattern only, never against the catalog** — auto-learn lags a newly-emitted key, so rejecting an unobserved key at save would block a legitimate condition.
- The server validates **op/value shape only, not field type** — exactly the rule the codebase already documents for `gte`/`lte` ("only checks that the VALUE is numeric, not that the field is a numeric one"). The server cannot know a `data.*` key's type at save time and the catalog is advisory, so type-based op filtering is a **UI convenience** (`opsForField`) with the server as the authority on value shape.

**Client (`automation.ts`, `AutomationPage.tsx`) — extend, don't fork, the B2 seams:**
- `CONDITION_FIELDS_BY_KIND` stays the static mirror; the `redis_event` **field dropdown** is composed at render as `[...CONDITION_FIELDS_BY_KIND.redis_event, ...dataKeys.map(k => \`data.${k.name}\`)]` from the bound event's `dataKeys`.
- **`opsForField`** gains the `data.*` case: a key typed `number` in the catalog → `['eq','neq','gte','lte','in']` (the existing `NUMERIC_CONDITION_FIELDS` branch's op set); `string`/`boolean` or unknown → the comparison set. Since `opsForField(kind, field)` has no catalog access today, it takes the key type as an optional argument (or the caller passes the resolved type) — do not duplicate the op sets.
- **The client validate must be extended:** it currently rejects any field not in `CONDITION_FIELDS_BY_KIND[kind]`, which would reject every `data.*` field. For `redis_event`, accept a pattern-matching `data.*` field (mirroring the server) so free-entry of a not-yet-observed key still validates.
- A key not yet in the catalog can still be typed (free-entry) since auto-learn lags; the picker is a convenience, not a gate.

## 6. Advisory `{data.*}` reference (Action templates)

In the `redis_event` trigger editor, show a small **read-only reference** listing the bound event's available `{data.*}` keys (from `dataKeys`), so the operator knows what to type into the bound Actions' `show_text`/`send_chat` templates. This is advisory copy only — no validation of Action templates against the catalog (Actions are shared across triggers/kinds). Empty catalog → a hint that keys appear once the app has sent an event.

## 7. Lifecycle — inert flagging (computed, not persisted)

- The automation editor computes, per `redis_event` trigger at load, whether it is **inert**: its `(appId, eventName)` is **not** in the app's current declared set, **or** its app is disabled, **or** its app no longer exists. An inert trigger renders a warning badge ("Won't fire — event no longer declared" / "app disabled" / "app removed") in the trigger list and detail.
- **Computed, never persisted:** no flag column, no migration, always accurate, and it matches runtime reality (C1's consumer already drops an undeclared event and skips a disabled app). A re-declared event clears the flag with no write.
- **Renames** are modeled as remove-old + add-new: the old-name-bound triggers flag inert; the operator rebinds to the new name. No dedicated rename path.
- **AppsPage remove hint:** removing a declared event is allowed (the C1 route is unchanged); the page shows a non-blocking "N trigger(s) reference this" count near the remove control so the operator sees the consequence ("warn loudly"). The count comes from a small server helper (`countTriggersForEvent(appId, eventName)`), not a client scan.

## 8. Schema (`db.ts`)

No new column and no data migration — `data_schema_json` already exists (C1, default `'{}'`), and an empty catalog is the correct default for every existing row. The only "migration" is defining the JSON's shape, which is code, not DDL. `addColumnIfMissing`/allowlists are unchanged from C1.

## 9. Testing strategy

- **Pure core (the correctness weight):** `inferKeyType` (each scalar, non-scalar→string, null/non-finite→skip); `mergeDataCatalog` (add new key; change type last-wins; unchanged→`changed:false`; absent key retained; malformed stored→`{}`). No DB/Redis.
- **Auto-learn:** a dispatched entry records its keys; a second identical entry writes nothing (`changed:false`); a dropped/undeclared entry never learns; a learn failure never stalls the loop (inject a throwing repo, assert the entry still XACKs and the loop continues). In-memory DB.
- **Conditions `data.*`:** `normalizeConditions` accepts `data.<key>` for `redis_event` and rejects a malformed field; the dispatcher exposes `data.<key>` in the condition context so a `data.wave gte 5` condition passes for a matching payload and fails closed for a missing key; a manual test-run still bypasses (B2).
- **Contract:** `AppEvent.dataKeys` parses `data_schema_json` and round-trips; an empty catalog → `[]`.
- **Lifecycle:** `countTriggersForEvent` returns the right count; the inert computation flags an undeclared/ disabled-app/removed-app trigger and clears on re-declare (pure helper unit-tested; UI via typecheck/build).
- **Editor:** `automation.test.ts` — the `data.*` field/op offering and free-entry; advisory reference presence. UI rendering verified via typecheck + build (no component harness).

## 10. Verification

`bun run typecheck`, `bun test`, `bun run build` all green. Manual (opt-in, real Redis + `STREAMER_TOOLS_CONSUME_INBOUND=1`): declare `boss_killed`, `XADD` `{"type":"boss_killed","data":{"boss":"Dragon","wave":3}}`; confirm the event's `dataKeys` becomes `[{boss,string},{wave,number}]` and the conditions editor offers `data.boss`/`data.wave` with type-appropriate ops; add a `data.wave gte 5` condition and confirm a `wave:3` event does not fire while a `wave:7` does; remove the `boss_killed` declaration and confirm the bound trigger shows an inert badge and stops firing, then re-declare (by sending an event again is NOT enough — the event NAME is operator-declared; re-add it) and confirm the badge clears.

## 11. Security & compatibility notes

- **No new trust surface.** Auto-learn only reads the already-parsed, already-bounded, already-declared `data` the C1 decision core produced; it writes a bounded key→type map (key names are top-level payload keys, already size/field-capped upstream). The safe-step allowlist and registration gate are untouched.
- **No secret exposure.** The catalog holds key *names* and coarse types, never values; `data_schema_json` is never returned raw to the client (only the parsed `dataKeys`).
- **SQLite compatibility.** Existing `app_events` rows read as empty catalogs; no migration, no re-run risk. `data_schema_json` writes are idempotent-by-content (`changed`-gated).
- **Stale-async.** The editor's catalog and inert state are computed from freshly-loaded data; there is no persisted flag to go stale.
