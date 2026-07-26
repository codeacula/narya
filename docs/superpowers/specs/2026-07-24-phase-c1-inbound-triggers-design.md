# Phase C1 — inbound Redis triggers (the security-critical path)

**Status:** Shipped and merged. Kept for the security-model rationale — see
`docs/superpowers/specs/2026-07-25-project-check-in-roadmap.md` §3/§5 for open
follow-up work that still cites this design.
**Date:** 2026-07-24
**Parent arc:** `2026-07-20-redis-automation-arc-design.md` §9 (Phase C). Depends on A (Redis layer, app registry, event bus — merged) and B (multi-action + conditions — merged). Phase C is split into **C1 (inbound path, this doc)** and **C2 (data-key catalog + lifecycle coupling)**.

---

## 1. Context & goal

Phase A made Narya *publish* events to Redis. C1 closes the loop inbound: an external registered app writes events to its own Redis stream, Narya consumes them and fires **operator-authored** `redis_event` triggers. Because the event `data` is attacker-controlled and inbound events cross a trust boundary, C1 is the security-critical phase: registration-gated delivery, a server-enforced safe step subset, per-entry poison isolation, and dedup that can't be weaponized.

**Deliverable:** the operator declares an app's inbound event name, binds a `redis_event` trigger to `(appId, eventName)` with an Action (safe steps only), the app `XADD`s an event to `narya:<env>:inbound:<appId>`, and Narya fires the Action once — with `{data.*}` from the payload rendered safely.

**Decisions locked in this brainstorm (2026-07-24):**
- The inbound consumer is **gated behind `config.consumeInbound`** (`STREAMER_TOOLS_CONSUME_INBOUND=1`) — a dev box never joins the operator's real consumer group or fires real triggers.
- `{data.*}` is **flat top-level keys**; non-scalar values coerce to a capped JSON string; unknown key → empty.
- The safe-step subset is enforced **at dispatch, source-aware** (not just at save): a `redis_event` run **skips** any blocked step (runs the rest, rolls up `partial`); plus a save-time editor warning.
- Dedup key `${trigger.id}:${appId}:${appSuppliedId}` (fallback: the unpredictable stream-entry id).

**Out of scope (C2):** the data-key catalog + pickable/validated `{data.*}` in the editor; lifecycle inert-flagging when an app removes/renames an event; de-registration blocking. **Out of scope (D):** the app **token** (inbound trust in C1 is by which per-app stream the event arrived on — the single-tenant broker assumption from arc §6.3; no token needed to consume).

## 2. Redis client + inbound consumer

### 2.1 Client extension (`redis.ts`)
Extend `RedisClientLike` with `xreadgroup`, `xack`, `xautoclaim`, `xgroup` (create group, `MKSTREAM`). Keep the injectable-factory test seam. Add read-side helpers used by the consumer (behind the same connection).

### 2.2 The consumer (`redisInbound.ts` — a peer module)
- **Wired in `index.ts`, never imported by `automation.ts`** (the windDown↔windDownLoop boot-cycle lesson): it needs the dispatcher, and `automation.ts` is the composition root. Lazy-connect like `obs.ts`; started/stopped via the `redis` reconcile branch.
- **Gate:** starts only when `config.consumeInbound` is true AND `redisUrl` is configured. Otherwise a no-op (a dev box, or an operator not using inbound, never consumes).
- Per registered, non-disabled app: ensure the consumer group on `narya:<env>:inbound:<appId>` (`XGROUP CREATE … MKSTREAM`, ignore BUSYGROUP), then loop `XREADGROUP GROUP <group> <consumer> COUNT n BLOCK m STREAMS <key> >`.
- **On startup, `XAUTOCLAIM`** the group's pending entries (recover a crash mid-processing) before the live read.
- **Inbound envelope** (mirrors the Phase-A egress shape; the app `XADD`s a `v` field holding this JSON): `{ type: <eventName>, id?: <app-supplied dedup id>, data: { … }, … }`. `type` is the **event name**; `id` is the optional app-supplied dedup id; `data` is the payload. `source`/`version`/`ts` may be present but are **ignored for trust** (provenance is the `appId` stream).
- **Per-entry processing** (isolated — a throw/poison never stalls the loop):
  1. Bound the entry: reject an entry whose serialized `data` exceeds a cap (e.g. 16 KB) or whose field count exceeds a cap → skip + `XACK` (it's handled, just dropped).
  2. Parse the envelope JSON; on failure (bad JSON / invalid UTF-8) or a missing/blank `type` → skip + `XACK`.
  3. **Drop if `type` isn't in that app's declared `app_events` set** — the registration gate. The envelope's self-declared `source` grants no privilege; provenance is the `appId` stream it arrived on.
  4. Dispatch to `handleRedisEvent({ appId, eventName: envelope.type, appSuppliedId: envelope.id ?? null, data: envelope.data ?? {} })`.
  5. **`XACK` only AFTER the dispatch's `claim()` inserted** the run row (or the event matched no trigger / was dropped). A crash before `XACK` leaves the entry pending → recovered by `XAUTOCLAIM` next startup (at-least-once); the dedup key makes reprocessing a no-op.
- **Decision core behind a port:** the parse → bound → drop-undeclared → dedup-key → dispatch logic is a pure/injectable function tested with a fake stream; only the `XREADGROUP`/`XACK`/`XAUTOCLAIM`/`XGROUP` wiring touches a live connection (opt-in integration smoke).

## 3. `redis_event` trigger source

- New `AutomationTriggerKind` `'redis_event'`; `RedisEventTriggerConfig = { appId: string; eventName: string }`. `normalizeConfig` validates `appId` against `apps` (must exist) and `eventName` against that app's `app_events` (must be declared).
- New dispatcher path `handleRedisEvent(signal)`: `signal = { appId, eventName, appSuppliedId: string | null, data: Record<string, unknown> }`. Candidates = enabled `redis_event` triggers whose `config.appId === appId && config.eventName === eventName`. Context = `{ data }` (plus `actor`/`login` only if the app supplies them as reserved data keys — otherwise absent; `role_is`/`tag_has` never resolve here, consistent with B2). `invokeAll` with `eventId` = the dedup id (below).
- **Dedup key `${trigger.id}:${appId}:${appSuppliedId}`** where `appSuppliedId` = the envelope `id` (§2.2) when present; else the **stream-entry id** (unpredictable, Redis-assigned). Passed as the `invoke` `eventId` so the existing `claim()` uniqueness applies. The `appId` in the key makes an un-namespaced app-supplied id a *within-app* concern only — App-A can never suppress App-B (different `appId`), and each trigger dedups independently (`trigger.id`). Inbound dedup survives `RUN_RETENTION_MS` (7 days) — documented.

## 4. `{data.*}` template extension (`actionTemplates.ts`)

- `TemplateContext` gains `data?: Record<string, unknown>`.
- Widen `TOKEN_PATTERN` from `/\{([A-Za-z][A-Za-z0-9:-]*)\}/g` to also allow `.`: `/\{([A-Za-z][A-Za-z0-9:.-]*)\}/g`.
- Add a `DATA_TOKEN_PATTERN = /^data\.([A-Za-z0-9_-]+)$/`:
  - `resolveToken`: on a `data.<key>` match, read `context.data?.[key]`; coerce — a string/number/boolean renders as its string; a non-scalar (object/array) renders as a **capped JSON string** (never `[object Object]`); `undefined`/missing → `''`.
  - `isKnownToken`: return **true** for a `data.<key>` match, so an absent key renders empty rather than leaving the literal `{data.foo}` in the output (matches the `{months}`-outside-a-resub rule).
- The existing **single-pass `.replace`** (no re-expansion of interpolated content) is the load-bearing invariant — `data` is attacker-controlled, so an interpolated value containing `{actor}` must not be re-resolved. Confirmed already true; asserted by a test.
- Numeric `{data.*}` flowing into an `adjust_counter` step's amount goes through **`parseCounterAmount`** (the `1e308`/range guard), never a raw `Number()`. (The step already renders its template then parses — confirm the `adjust_counter` path uses `parseCounterAmount` on the rendered value.)

## 5. Safe step subset (server-enforced, dispatch-time)

The security boundary. Actions are shared and independently editable, so a save-time check alone is insufficient (an Action bound to a `redis_event` trigger could gain a `twitch_ban` step later). Enforce at **run time, source-aware**:
- `REDIS_SAFE_STEP_TYPES = { 'show_text', 'play_media', 'tts_speak', 'adjust_counter', 'send_chat' }`. Everything else (`obs_scene`, `obs_transition`, `twitch_whisper`, `twitch_timeout`, `twitch_ban`, and any future step) is **blocked** for this source.
- The executor's `runAction` gains an optional `options: { allowedStepTypes?: ReadonlySet<ActionStepType> }`. A step whose `type` isn't in the set → result **`skipped`** with a detail (`blocked: <type> is not allowed from an external event`); it **broadcasts nothing** and never dispatches. So the run rolls up `partial` (some safe steps ran, blocked ones skipped) or `skipped` (all blocked).
- The dispatcher, in `invoke()`, passes `{ allowedStepTypes: REDIS_SAFE_STEP_TYPES }` to `runAction` **iff `trigger.kind === 'redis_event'`** (both the override list and the base list). All other sources pass nothing (unrestricted).
- `send_chat` from an inbound source is **length-capped** (reuse the existing chat length limit).
- **Editor save-time warning:** binding a `redis_event` trigger to an Action containing blocked steps shows a non-blocking warning ("these steps won't run from an external event"). The runtime skip is the real guarantee.

## 6. `app_events` (minimal — event-name declaration)

- `app_events(app_id, event_name, data_schema_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, PRIMARY KEY (app_id, event_name), FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE)`. C1 uses only `event_name` (the drop-undeclared set + the trigger-editor picker); `data_schema_json` is reserved for C2's data-key catalog (defaults `{}`).
- `apps.ts` gains: `listAppEvents(appId)`, `declareAppEvent(appId, eventName)`, `removeAppEvent(appId, eventName)`, `isDeclaredEvent(appId, eventName)`; REST under `/api/apps/:id/events`. The apps Settings section gains an event-name list per app.
- The consumer's drop-undeclared check calls `isDeclaredEvent(appId, eventName)`. `normalizeConfig` for `redis_event` validates the bound `eventName` is declared.

## 7. Config / dev-safety

- `config.ts` gains `consumeInbound: process.env['STREAMER_TOOLS_CONSUME_INBOUND'] === '1'` (boot/infra env — like `port`/`host`; NOT a Settings-owned value).
- The stream key prefix reuses the Phase-A env prefix (`narya:<prefix>:inbound:<appId>`), so a dev box (which also must set `consumeInbound` to even try) is doubly separated. Document the shared-`redisUrl` + inbound hazard next to the existing dev-safety notes.
- The `redis` reconcile branch starts/stops the inbound consumer alongside the outbound client.

## 8. Testing strategy

- **Consumer decision core (no live Redis):** drop-undeclared (an undeclared event never dispatches); size/field bounds reject oversized entries; a poison entry (bad JSON) is skipped, not fatal; the dedup-key derivation (`trigger:app:suppliedId`, fallback stream id) and the **cross-app-suppression-impossible** property (App-A's id can't collide with App-B's key).
- **`{data.*}` render:** coercion (string/number/bool/object/array/missing), unknown-key → empty, single-pass no-re-expansion (an interpolated `{actor}` in `data` is not re-resolved), numeric `{data.*}` → `parseCounterAmount` range guard.
- **Safe subset:** a `redis_event`-sourced run skips `twitch_ban`/`obs_scene`/etc. and runs `show_text`/`play_media`/... ; a non-redis source runs everything; the skip broadcasts nothing.
- **Dispatch:** `handleRedisEvent` fires matching `(appId,eventName)` triggers once; conditions (B2) still gate; dedup makes a redelivered entry a no-op; an undeclared/unbound event fires nothing.
- **Opt-in integration smoke (env-flagged, not in the in-memory suite):** `XGROUP`/`XREADGROUP`/`XACK`/`XAUTOCLAIM` pending-recovery against a real Redis.

## 9. Verification

`bun run typecheck`, `bun test`, `bun run build` green. Manual (opt-in, real Redis + `STREAMER_TOOLS_CONSUME_INBOUND=1`): register an app, declare an event `boss_killed`, bind a `redis_event` trigger to `(app, boss_killed)` with a `show_text` Action using `{data.boss}`, `XADD` `narya:<env>:inbound:<appId> * v '{"type":"boss_killed","data":{"boss":"Dragon"}}'`, confirm the overlay shows the text once; add a `twitch_ban` step to the Action and confirm it never fires from inbound; re-`XADD` the same id and confirm no second fire. With `consumeInbound` unset, confirm nothing is consumed.
