# Redis event bus + trigger/reward rework — architecture & phasing

**Status:** Design approved (arc-level). Each phase gets its own implementation spec + plan before code.
**Date:** 2026-07-20
**Scope:** Architecture and phasing for four sub-projects. This is the altitude a whole-arc doc holds — per-phase implementation detail lives in the phase specs that follow.

---

## 1. Summary

Turn Narya from a closed automation tool into the hub of a small ecosystem of cooperating apps that
share one Redis broker:

- **Narya publishes its events to Redis** (redeems, Twitch events, module switches) so any external
  app — e.g. the operator's PZTMI project — can listen and react.
- **Rewards carry provenance** (`source` + `external_ref`), so a redeem event tells a listener "this
  was your reward."
- **External apps can emit events back through Redis** that Narya reacts to via operator-authored
  triggers.
- **Triggers stop being 1:1.** A trigger gains a `name`, a list of `conditions`, and a list of
  `actions` it runs.
- **External apps can provision categorized rewards** over Narya's REST API, tagged with their own
  source.

The result: "any little app can listen," and Narya becomes the provisioning + eventing spine.

## 2. Goals / non-goals

**Goals**
- A durable, documented, versioned event contract external apps can build against.
- A registration model where an external app is a first-class, identified entity.
- A richer trigger model (name + conditions[] + actions[]) that also serves inbound Redis events.
- Provisioning that lets an app own and manage its own categorized rewards without touching others'.
- Every step of this remains **optional**: Narya boots and runs exactly as today with no Redis
  configured.

**Non-goals (explicitly deferred)**
- HMAC-signed ingress (documented as the hardening path if Redis is ever exposed beyond a trusted
  broker — see §6 trust model).
- A Narya-side persisted outbox for events emitted while Narya's own Redis link is down (§5.A).
- OR / nested boolean condition graphs (v1 is AND-only; OR via multiple triggers).
- Per-type egress streams and a Redis-RPC provisioning channel (REST is the provisioning transport).
- Discord or any other transport as an event sink — this is Redis-only.

## 3. The four sub-projects and their order

| # | Sub-project | Delivers | Depends on |
|---|---|---|---|
| **A** | Redis foundation: outbound bus + app registry + reward provenance | Narya publishes events; apps are registered entities; rewards are source-tagged. PZTMI listens and reacts on redeem. | — |
| **B** | Trigger model rework: `name` + `conditions[]` + `actions[]` | The 1:N restructure of the automation core. | — (independent of Redis) |
| **C** | Inbound Redis triggers (registration-gated, safe-step-only) | External apps emit events Narya reacts to. | A (registry + bus) and B (conditions + multi-action) |
| **D** | External reward provisioning over REST + app token | Apps self-service categorized, source-tagged rewards. | A (registry + provenance) only |

**Order: A → B, then C, with D able to proceed in parallel once A lands** (D needs only the registry
and provenance table, not B/C). Each is its own spec → plan → build cycle. A is the keystone: it
proves the vision end-to-end and settles the Redis infrastructure every later phase reuses.

---

## 4. Cross-cutting: the Redis layer

### 4.1 Client and lifecycle
- **`ioredis`** (new dependency). Complete Streams + consumer-group + reconnection support; Bun's
  native `Bun.redis` is thinner on `XREADGROUP` today. A later swap is possible behind the port.
- New module `src/server/redis.ts` owns a single connection, modeled on `obs.ts`: lazy-connect,
  reconnect-on-close, an attached `error` handler so a failure never escapes, and **survives
  Redis-down-at-boot**.
- ioredis is configured `enableOfflineQueue: false` with a bounded `maxRetriesPerRequest`, so a
  command issued while disconnected **fails fast and is dropped**, never queued unboundedly.

### 4.2 Optionality
- No `redisUrl` configured → the whole layer is a no-op: `publishNaryaEvent` returns immediately,
  no inbound consumer starts, the app boots normally.
- **A Redis hiccup must never break a redeem.** Every publish is `void`-ed with a `.catch()` — never
  `await`-ed on the redeem/chat path. A `redeemOnce`-style test proves a throwing or hanging bus
  neither delays nor fails the redeem path.

### 4.3 Configuration (secret handling)
`redisUrl` is **both** an operator-editable connection string **and** a secret (it may embed a
password). It therefore follows the *secret* pattern in `appConfig.ts`, **not** the raw-URL pattern
(`toPublic` returns `obsUrl`/`tengwarBaseUrl` in clear — do not copy that):
- Stored column; `resolveSecret` "absent-means-keep" directive + a `clearRedisUrl` directive.
- `toPublic` exposes only `redisConfigured: boolean` — never the URL or host. (Accepted UX cost: the
  operator can't see the configured host; full redaction beats parsing the URL to redact only the
  password.)
- Redacted in **every** log line ioredis can emit (it logs the connection address on error).
- Never added to any overlay-reachable payload, and `settings:updated` stays `{ updatedAt }` only.
- Save-time validation that the value is `redis://` or `rediss://`.

### 4.4 Reconcile — start/stop, not just reconnect
A new `redis` `AppConfigChange`. Unlike every existing reconcile branch (which only *reconnects*
services that already exist), the `redis` branch must **start** the client + inbound consumer when a
URL first appears and **tear them down** when it's cleared.

### 4.5 Health signal (operability)
Fire-and-forget makes a dead bus invisible, which violates the "how will a production failure be
detected?" bar. Add:
- `redisConnected` (and last-publish-error) to `DashboardStatus`.
- Connect/drop transitions through `ServiceStatusToasts`, plus a persistent inline Settings alert
  when `redisConfigured` but not connected.
- An operator-visible per-consumer-group lag/PEL readout (`XINFO GROUPS`) so a stuck external
  consumer is diagnosable before Redis fills.

### 4.6 Environment namespacing (dev safety)
`redisUrl` lives in the shared DB config, so a `bun run dev` box (or any second Narya) points at the
**same** broker — extending the existing "dev hits live services" hazard. On egress it would pollute
the live stream; on **ingress it is actively dangerous** — a dev consumer with the same group name
steals and ACKs the operator's real inbound entries, and can fire real moderation-capable triggers.
Mitigations, mandatory:
- **Namespace all stream keys and consumer-group identity by an env-derived prefix.**
- **Gate the ingress consumer behind an explicit "this instance consumes inbound" flag** so a dev box
  never joins the operator's real group or fires real triggers.
- Document the shared-`redisUrl` hazard next to the existing dev-safety memory.

---

## 5. Cross-cutting: the event envelope (public contract)

```jsonc
{
  "version": 1,                    // schema version; additive-only within a major
  "id": "<derived from source event id>", // THE dedup key (see below)
  "type": "redeem",                // event type
  "ts": "<ISO8601>",
  "channel": { "id": "<broadcaster user_id>", "login": "<login, informational/mutable>" },
  "source": "narya",               // producer; on INGRESS this field is ignored for trust
  "data": { /* type-specific, field-allowlisted */ }
}
```

Decisions baked into the envelope:
- **`id` is derived deterministically from the source event id** (EventSub `message_id`, chat message
  id, redemption id), with a random fallback only for sources that genuinely have none. A fresh UUID
  per publish would give external apps nothing stable to dedup on across EventSub redelivery.
  `id` is documented as **the** dedup key external consumers should use.
- **`channel` carries the immutable `user_id`**; `login` is present but flagged mutable and must not
  be used as a stable key (a Twitch rename would split a consumer's filter otherwise).
- **`version` + an additive-only compatibility policy** (breaking changes bump the version and are
  announced). The data schema is documented per event type. Because the consumers live outside this
  repo, this version field replaces the "trace every consumer" discipline Narya uses internally.
- **`source` is a trust signal on egress only.** On ingress (Phase C) the same field is present but
  **self-declared by the writer and never used for any trust, provenance, or routing decision** — app
  identity comes solely from the ingress mechanism (§6).

### 5.A Durability guarantee (stated, not implied)
Streams were chosen for "offline apps catch up," but that guarantee is only as real as the trimming
and the operator's Redis config, so the spec states it concretely:
- **Retention is pinned in time, not count.** Trim with `MINID` against a timestamp-derived id to
  retain a **rolling window (target: ~48h)** rather than `MAXLEN ~ N` (which, on a single stream
  carrying all types, collapses to minutes during a follow/cheer/sub flood and evicts redeems to
  unrelated volume).
- **Durability requires operator Redis config** (`appendonly yes` or RDB; a non-evicting
  `maxmemory-policy`). Narya `CONFIG GET`s these at connect and **logs a loud warning** when the
  policy can evict; the durability claim is scoped explicitly to "a persistently-configured Redis."
- **The guarantee covers *consumer* downtime only** — not publisher downtime or events emitted before
  Redis was configured (no outbox in v1). Stated plainly so operators don't over-trust it.
- **Egress field allowlist** (the `OVERLAY_EVENTS` discipline turned outward): per event type, an
  explicit list of which fields cross to external readers. Enabling Redis broadens data exposure
  (viewer logins, cheer amounts) beyond the app's trust boundary — that is an informed operator
  choice, and non-essential PII is left off the wire.

---

## 6. Cross-cutting: app registry + trust model

### 6.1 The registry
An external app is a first-class row minted in Settings:

```
apps(id, name, token_hash, scopes, created_at, disabled_at)
app_events(app_id, event_name, data_schema_json)   -- declared inbound events + their data-key catalog
```

- **`source` (provenance) maps to the registry.** `narya` and `manual` are reserved sentinels
  (seeded, not real apps); every other `source` validates against `apps`. The redeem-join maps a
  `source` string to its registry app for the `rewardSource` envelope field.
- **`app_events` stores declared inbound event *names and their data-key catalog*** — not just names.
  This is what lets the trigger editor make `{data.*}` **pickable and validated** instead of
  blind-typed (§8, §9).

### 6.2 App-token lifecycle
- Token is ≥128-bit random, **shown once at mint, never retrievable**; stored as SHA-256 `token_hash`.
- Authenticated by hashing the presented token and looking it up (constant-time compare where a
  direct compare is used, mirroring `auth.ts` `tokensMatch`).
- The registry GET never returns the token or hash — only a configured flag / last-4.
- **Revocation is immediate and total:** disabling/deleting an app rejects its API token, stops
  honoring its inbound events, tears down its consumer group, and flags any operator triggers bound
  to its events as inert (§C lifecycle). Rewards it provisioned persist on Twitch with provenance
  retained but become unmanageable via the API.
- Consider separating the ingress identity from the reward-provisioning token, since the latter is a
  Twitch-mutating capability (decided in the Phase C/D specs).

### 6.3 Trust model (the two decisions the review forced)
- **Broker is single-tenant.** `redisUrl` is guarded exactly like `DASHBOARD_TOKEN`; Redis runs on
  loopback / a private LAN reachable only by the operator's own processes. Under that assumption,
  **each app writes to its own inbound stream** (`narya:inbound:<appId>`, env-prefixed), and the
  stream identity provides provenance. **HMAC-signed envelopes are the documented hardening path** if
  Redis is ever exposed to untrusted writers — at which point per-app-stream provenance is no longer
  sufficient (anyone who can write can XADD claiming to be that app).
- **Inbound-fired Actions are restricted to a server-enforced safe step subset:**
  `show_text`, `play_media`, `tts_speak`, `adjust_counter`, and `send_chat` (length-capped).
  `twitch_ban` / `twitch_timeout` / `twitch_whisper` / `obs_scene` / `obs_transition` are **blocked
  server-side** for `redis_event`-fired Actions. Rationale the review made explicit: the
  "operator triggers are the effect gate" framing bounds *which* trigger fires, **not who/what it
  targets** — `{data.*}` is attacker-controlled and would otherwise flow into a ban target. The safe
  subset means an external app can drive overlays / sounds / counters / chat but can never pick a
  moderation victim. Even within the subset, `{data.*}` is treated as the same attacker-controlled
  threat class as chat text (coercion + range guards, §C).

---

## 7. Phase A — outbound bus + reward provenance

**New:** `src/server/redis.ts` (connection), `src/server/eventBus.ts` (envelope build + publish),
`reward_provenance` table, app registry (identity + token; declared-events/data-catalog can land with
C), Settings surface for Redis + apps.

**Egress choke point.** `publishNaryaEvent(type, data)` builds the envelope and `XADD`s it. It is
called from **exactly one choke point per source event, placed after the existing merge/dedup
decision** — not per emit branch. Emit sites span `eventsub.ts`, `chat.ts`, **and**
`categoryModules.ts` (module lifecycle). A resub that fires both `channel.subscribe` and
`subscription.message` must publish **once** (suppressed the same way the Action dispatch already is
via `sub_merge_state`); the `watch_streak` pseudo-redeem must not masquerade as a redemption. A **bus
analogue of `redeemOnce.test.ts`** asserts exactly one envelope per real event across redelivery and
sub-merge.

**Provenance.** `reward_provenance(reward_id PK, source, external_ref, created_at)`. Independent of
`categoryId` (a reward can be in category "Games" *and* sourced "pztmi").
- The redeem envelope carries `rewardSource` + `rewardExternalRef`, joined on `reward_id` at emit
  time.
- **Provenance completeness (or the join silently misses):** the operator's own
  `POST /api/twitch/rewards` writes `source` (`narya`/`manual`); the `DELETE` handler clears the
  provenance row; and a **self-healing upsert-on-`fetchRewards`** inserts `source='manual'` for any
  reward id not yet known (rewards born on the Twitch dashboard, mobile, etc.). This replaces a
  one-shot backfill — which can't even reach the full reward list without a live authed `fetchRewards`.
- **A join miss is `null`, never a fabricated `manual`,** and a **missing provenance row must never
  gate dispatch** — the Action still fires.

**Deliverable:** PZTMI (a registered app) listens on the egress stream, filters `type=redeem` +
`rewardSource=pztmi`, and reacts. Items 4 & 5 of the original vision, end-to-end.

---

## 8. Phase B — trigger model rework (the highest-blast-radius phase)

`kind` stays as the **event source** (dispatcher still indexes candidates by kind). Layered on:

**Schema**
- `automation_triggers.name TEXT` (backfilled by a **total** function — never empty; fall back to
  `kind` + short id), `conditions_json TEXT DEFAULT '[]'`.
- `automation_trigger_actions(trigger_id, action_id, position, enabled)` join table with
  `UNIQUE(trigger_id, action_id)` and on-delete-cascade on both FKs, added to the FK/orphan
  documentation.
- **`automation_triggers.action_id` is kept intact** after migration (CLAUDE.md "legacy left intact")
  so the join is always re-derivable.

**Migration safety** (the watch-server + `runOnce` trap)
- `automation_triggers` added to `allowedMigrationTables`; `name`/`conditions_json` to
  `allowedMigrationColumns` + `allowedMigrationDefinitions`.
- The join table gets a **self-healing guard** modeled on `dropStaleLlmInteractions`
  (drop-and-rebuild-from-`action_id` when `position`/`enabled` is missing), run **before** the
  `runOnce` copy — because a `bun --watch` reload that persists an intermediate table shape would
  otherwise burn the `runOnce` ledger id and skip the corrected migration forever.
- The copy is re-derivable from the retained `action_id`, not a bare one-shot. Verified in a
  `*.test.ts` against the in-memory DB — never an ad-hoc script against the live DB.

**Dispatch**
- **One `automation_runs` claim per (trigger, event)**, then all enabled join actions run and roll up
  via a **single** `finishRun`. A per-action loop is forbidden and the spec says why: the second
  action collides on the `(trigger, event)` unique index and silently no-ops.
- **`UNIQUE(trigger_id, action_id)`** (or executor-side de-dup) so an action can't be listed twice —
  otherwise one reward trigger plays a clip twice with no redelivery, reopening the double-play class
  `redeemOnce.test.ts` guards. Extend that test with a two-action-same-asset trigger.
- **Zero enabled actions → skip the claim entirely** (occupy no cooldown/dedup). Decide whether
  deleting the last action deletes the trigger or leaves it inert-and-flagged.
- **Execution semantics:** a trigger's N actions run **concurrently**, mirroring the `action_steps`
  t0 model (`delayMs` relative to invocation start). `position` is **display order only**; overlapping
  media lanes are the operator's responsibility exactly as two `play_media` steps in one action are
  today. (Stated explicitly because concurrent-vs-sequential produces visibly different stream
  behavior.)

**Conditions**
- `{ field, op, value }[]`, **AND** semantics v1, evaluated by a **pure `evaluateConditions`**
  (unit-tested like `evaluateWindDown`).
- **Order: arming → source/config match → conditions → cooldown → claim → run.** A non-matching event
  must not claim a run row or consume cooldown (else a later event that *would* match is swallowed).
- Ops: `eq / neq / contains / starts_with / gte / lte / in / role_is / tag_has`. **No regex, by
  design** (ReDoS on attacker-controlled chat), recorded in writing.
- Edge cases pinned: **missing field → condition false** (fail-closed; `neq` reconsidered
  explicitly); `gte/lte` coerce both sides with `Number()`, `NaN → false`; per-op value-shape
  validation at write time (`normalizeConditions` mirroring `normalizeConfig`); an unreadable
  `conditions_json` **fails closed** for a moderation-capable trigger (and that's tested).
- **`role_is` / `tag_has`:** one role vocabulary end-to-end (fix `moderator` vs `mod` mismatch);
  `role_is` = **has-role** via `getViewerRolesFromBadges`; `tag_has` routed through
  `normalizeProfileTag`. role/tags resolve for every source that carries a login (not just chat), or
  the editor hides those ops where they can't resolve. **For non-viewer events (reward, twitch_event,
  redis_event) they evaluate against an empty set and never pass** — and the spec states conditions
  **filter intent, not authenticity**; they are never the ingress auth boundary.

**Contract blast radius** (trace every producer/consumer): `AutomationTrigger` union carries
`actionId` on every member; `AutomationTriggerInput`, `normalizeAutomationTriggerInput`,
`TriggerRunSummary`, `invoke`/`runAction`, and `SlashCommandResponse.run` (single `ActionRunResult`
surfaced to the dashboard) all change. Decide whether the API keeps a back-compat single-`actionId`
shim or fully switches to `actions[]`; if it switches, enumerate and update every consumer, and
reshape `SlashCommandResponse.run`/`TriggerRunSummary` for N results with the dashboard consumer
updated.

---

## 9. Phase C — inbound Redis triggers (registration-gated, safe-step-only)

**Source + binding.** New source kind `redis_event`, config binds to a specific **(appId,
eventName)** pair (not `eventName` alone — otherwise a low-trust app registering `boss_killed` fires a
high-trust app's trigger). Plus `conditions[]` over the event `data`.

**Consumer.** A **peer module wired in `index.ts`** (never imported by the `automation.ts` composition
root — the windDown↔windDownLoop boot-cycle lesson). It reads each registered app's per-app inbound
stream (`narya:inbound:<appId>`, env-prefixed), lazy-connects like `obs.ts`, and is started/stopped
via the `redis` reconcile branch. Server-side it **drops any event whose name isn't in that app's
declared set**, and the envelope's self-declared `source` grants no privilege.

**Dedup + delivery.**
- Dedup key `${trigger.id}:${appId}:${appSuppliedId}` (fallback: the stream-entry id). The
  `automation_runs` unique index is global on `dedupe_key`, so an un-namespaced app-supplied id is a
  cross-app **suppression primitive** (pre-claim a predictable id and a legitimate event no-ops).
- **`XACK` only after `claim()` has inserted** the run row (else at-most-once on crash). Recover
  pending entries with **`XAUTOCLAIM` on startup**. Inbound dedup survives only within
  `RUN_RETENTION_MS` (7 days) — documented.
- Per-entry isolation: a poison entry (multi-MB `data`, invalid UTF-8, bad JSON) is skipped
  per-entry and never stalls the loop. Inbound entry/field size is bounded.

**`{data.*}` template extension.**
- `TemplateContext` gains `data?: Record<string, unknown>`. `TOKEN_PATTERN` is widened to allow `.`;
  a `DATA_TOKEN_PATTERN` branch is added to **both** `resolveToken` and `isKnownToken` (they're fixed
  allowlists; otherwise `{data.foo}` renders verbatim).
- Flat-key semantics (or explicit nested-path), **coercion for non-scalar values** (so `{data.obj}`
  doesn't render `[object Object]`), and unknown-key behavior are defined. The single-pass
  no-re-expansion invariant is stated explicitly because `data` is attacker-controlled.
- Numeric `{data.*}` into `adjust_counter` routes through the existing `parseCounterAmount` range
  guard (the `1e308` viewer-input lesson), never a raw `Number()`.

**Safe step subset (server-enforced).** As decided: `redis_event`-fired Actions may only use
`show_text` / `play_media` / `tts_speak` / `adjust_counter` / `send_chat` (length-capped). Moderation
and OBS steps are rejected server-side for this source.

**Lifecycle coupling.** If an app removes/renames a declared event (or is deleted in Phase D), every
operator trigger still bound to that (appId, eventName) is **flagged inert in the editor** with a
warning rather than silently dropping. De-registration either blocks while triggers reference the
name or warns loudly.

---

## 10. Phase D — external reward provisioning (REST + app token)

**Auth.** `/api/apps/*` needs its **own middleware** — `requireDashboardToken` 401s anything that
isn't the operator/overlay secret, so an app token would be rejected before the handler. A distinct
app-token check does a `token_hash` registry lookup, **never satisfies operator/overlay routes, and
is never satisfied by an operator/overlay token.** Registry `scopes` are enforced server-side per
route (provisioning vs event-emit).

**Isolation is one `WHERE source = ?` clause — make it a hard invariant.** Every reward Phase D
creates is minted under Narya's single Twitch `client_id` with the *operator's* OAuth token, so
Twitch's `canManage` / `only_manageable_rewards` returns true for **all** narya-created rewards —
Twitch provides **zero** isolation between apps. Therefore every `/api/apps/rewards` GET/PATCH/DELETE
resolves `source` from the token and runs `WHERE reward_id = ? AND source = ?` (404 on miss), never
trusting a client-supplied `reward_id` alone. A `redeemOnce`-style test proves app `foo` cannot touch
app `pztmi`'s (or a `manual`, or a Narya-UI) reward. The spec states plainly: `canManage` (Twitch,
per-client-id) and `source` (provenance, per-app) are independent, and **Twitch enforces neither the
source boundary nor per-app caps.**

**Quota + idempotency.**
- **Per-app reward quota** enforced against `reward_provenance` (`count WHERE source=? < limit`)
  before the Twitch create, because the Twitch per-channel cap is a shared pool across manual,
  Narya-UI, and every app. Define the operator-visible error when the shared cap 400s (which app
  holds how many).
- **`UNIQUE(source, external_ref)`;** `POST` is an **upsert keyed on (source, external_ref)** —
  `external_ref` is the app's idempotency key, so a retried provision returns the existing reward
  instead of minting a second Twitch reward and burning cap.

**Operational risks documented:**
- Changing `appConfig.twitchClientId` strands every provisioned reward (`canManage` flips false;
  provenance-backed management 403s). Warn the operator or re-derive `canManage` from a fresh
  `fetchRewards` on a client-id change.
- The category coordinator toggles rewards by group membership regardless of `source`, so a game
  switch can disable an app's reward. **Default: keep today's behavior** (coordinator toggles by group
  membership); the app observes the change only once the deferred `reward.state_changed` egress event
  (§13) exists. Excluding non-`manual`/`narya`-source rewards from coordinator toggling is the
  alternative to weigh in the Phase D spec.

---

## 11. Testing strategy

- **Pure functions** carry the correctness weight and are unit-tested: envelope build, deterministic
  `id` derivation, `evaluateConditions`, `{data.*}` render/coercion.
- **Ports + DI** (the `actionExecutor` style) keep publish/consume testable with **no live Redis** —
  an injected `xadd`/consumer port or `mock.module` (as `redeemOnce.test.ts` mocks realtime).
- **Bus double-play guard:** a `redeemOnce`-analogue asserting one envelope per real event across
  redelivery and sub-merge; and the two-action-same-asset trigger case.
- **Migration:** verified in a `*.test.ts` against the in-memory DB (`NODE_ENV=test`), never an
  ad-hoc script (the live-DB import-hoist hazard).
- **Opt-in integration smoke** (gated on an env flag so it never runs in the in-memory path, or a
  documented docker/redis script) for the wire behaviors ports can't exercise: connect/disconnect,
  publish-while-down, a consumer group across a Redis restart (NOGROUP), and `XAUTOCLAIM`
  pending-recovery. Plus documented manual smoke steps after configuring `redisUrl`.

---

## 12. Open decisions — resolved

| Decision | Resolution |
|---|---|
| Bus transport | **Redis Streams** (durable), retention pinned in time via `MINID` (~48h target). |
| Trigger model | **Source + `conditions[]` + `actions[]`**; `kind` stays as the indexed source. |
| Inbound trust | **Operator triggers are the only effect path**, further bounded by a safe step subset. |
| Provisioning transport | **REST + app token**; Redis stays event-only. |
| Ingress auth | **Single-tenant broker + per-app inbound stream**; HMAC-signed envelopes deferred as hardening. |
| Inbound-fired Action effects | **Server-enforced safe step subset** (no moderation/OBS). |
| `envelope.id` | **Derived from source event id**; documented as the external dedup key. |
| Multi-action execution | **Concurrent** (t0 model); `position` is display order only. |
| `provenance.source` | Registry-backed string; `narya`/`manual` reserved sentinels. |

## 13. Deferred / future hardening
HMAC-signed ingress; a Narya-side persisted outbox (survive publisher downtime); OR/nested
conditions; per-type egress streams; separating the ingress-signing key from the reward-provisioning
token; a `reward.state_changed` egress event.
