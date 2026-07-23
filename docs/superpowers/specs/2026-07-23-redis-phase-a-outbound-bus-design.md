# Phase A — outbound event bus + reward provenance + names-only app registry

**Status:** Approved (design). Implementation plan to follow.
**Date:** 2026-07-23
**Parent arc:** `2026-07-20-redis-automation-arc-design.md` (Phase A is the keystone).

---

## 1. Context & goal

Phase A is the first sub-project of the Redis automation arc. It turns Narya from a closed tool into
the event-producing spine of a small ecosystem: Narya publishes its events to a Redis broker so any
external app (e.g. the operator's PZTMI project) can listen and react, and rewards carry provenance so
a redeem event tells a listener "this was your reward."

**Proof-of-life deliverable:** the operator configures a Redis URL, registers an app named `pztmi`,
and tags a channel-point reward with `source=pztmi`. When a viewer redeems it, PZTMI — reading the
Redis stream directly — sees a `type=redeem` envelope with `rewardSource=pztmi` and reacts.

**Decisions locked in this brainstorm (2026-07-23):**
- Egress publishes **all three event families** — redeems, Twitch events, category-module switches.
- The registry is **names-only** this phase (`apps` identity rows only); the app token/hash and its
  auth are deferred to Phase C/D, which is where anything first consumes a token.
- Reward source assignment is an **operator UI action** on the existing Viewer Rewards page (no
  external provisioning yet — that is Phase D).
- Everything remains **optional**: with no `redisUrl` configured the whole layer is a no-op and Narya
  boots and runs exactly as today.

**Explicitly out of scope (later phases):** app tokens/auth, inbound Redis triggers (Phase C),
external reward provisioning (Phase D), HMAC-signed ingress, a persisted publisher outbox, per-type
egress streams, per-type egress toggles.

## 2. New surface at a glance

| Area | New / changed |
|---|---|
| Modules | `src/server/redis.ts` (connection), `src/server/eventBus.ts` (envelope build + publish) |
| Tables | `reward_provenance(reward_id PK, source, external_ref, created_at)`, `apps(id, name, created_at, disabled_at)` |
| Config | `redisUrl` (secret), `redisConfigured` boolean, `clearRedisUrl` directive, new `redis` `AppConfigChange` |
| Choke points | one `publishNaryaEvent(...)` call each in `eventsub.ts`, `chat.ts`, `categoryModules.ts` |
| Provenance writes | `viewerRewards.ts` reward POST/DELETE + self-healing upsert on `fetchRewards` |
| Registry routes/UI | `src/server/apps.ts` (CRUD) + a Settings apps section; a reward source selector on the Viewer Rewards page |
| Status | `redisConnected` + `lastPublishError` on `DashboardStatus`; `ServiceStatusToasts`; inline Settings alert |
| Contracts | `src/shared/api.ts` — envelope type, `App`, provenance fields on the reward payload, status fields |

## 3. The Redis layer (`redis.ts`)

Modeled on `obs.ts`:
- A single `ioredis` connection (**new dependency**; `Bun.redis` is thinner on the stream/consumer-group
  APIs the later phases need — a swap stays possible behind this module's port).
- Lazy-connect; reconnect-on-close; an attached `error` handler so a failure never escapes as an
  unhandled rejection; **survives Redis-down-at-boot** (a bad/unreachable URL logs and retries, never
  crashes the process).
- Configured `enableOfflineQueue: false` with a bounded `maxRetriesPerRequest`, so a command issued
  while disconnected **fails fast and is dropped** rather than queuing unboundedly.
- Exposes: `getRedisConnectionState()` (for the health signal), `startRedis()` / `stopRedis()` (for
  reconcile), and a low-level `xadd(key, fields)` port that `eventBus.ts` calls (kept separate so tests
  inject a fake and need no live Redis).
- On connect, `CONFIG GET maxmemory-policy` (best-effort) and **log a loud warning** if the policy can
  evict, because the ~48h retention guarantee is only real on a non-evicting, persistently-configured
  Redis.

### 3.1 Optionality (the hard rule)
- No `redisUrl` → `startRedis()` is never called; `publishNaryaEvent` returns immediately; the app
  boots normally.
- **A Redis hiccup must never break a redeem.** Every publish is `void`-ed with a `.catch()` and is
  **never `await`-ed on the redeem/chat/module path.** A `redeemOnce`-style test proves a throwing or
  hanging bus neither delays nor fails the redeem path.

### 3.2 Dev-safety namespacing
All stream keys are namespaced by an **env-derived prefix** (default derived from `NODE_ENV`, e.g.
`narya:<envPrefix>:events`), so a `bun run dev` box sharing the operator's `redisUrl` cannot pollute
the live stream. (Ingress group-identity gating is a Phase C concern; not needed for outbound-only.)
Document the shared-`redisUrl` hazard next to the existing dev-safety note.

## 4. Configuration (secret handling)

`redisUrl` is both operator-editable and a secret (it may embed a password), so it follows the
**secret** pattern already used for `twitchClientSecret` / `obsPassword` in `appConfig.ts` — **not**
the raw-URL pattern (`obsUrl`/`tengwarBaseUrl` return in clear; do not copy that):
- Stored column `redis_url`; resolved via `resolveSecret(update.clearRedisUrl, update.redisUrl, prev.redisUrl)`.
- `toPublic` exposes only `redisConfigured: Boolean(internal.redisUrl)` — never the URL or host.
  (Accepted UX cost: the operator can't see the configured host; full redaction beats parsing the URL
  to redact only the password.)
- Save-time validation that the value is `redis://` or `rediss://`.
- Redacted in **every** log line (ioredis logs the connection address on error) — never logged raw.
- Never added to any overlay-reachable payload; `settings:updated` stays `{ updatedAt }` only.

### 4.1 Reconcile — start/stop, not just reconnect
A new `redis` `AppConfigChange`. Unlike every existing `reconcileServices` branch (which only
*reconnects* a service that already exists), the `redis` branch must **start** the client when a URL
first appears and **tear it down** when it is cleared.

## 5. The event envelope (public contract)

```jsonc
{
  "version": 1,                    // schema version; additive-only within a major
  "id": "<derived from source event id>", // THE dedup key
  "type": "redeem",                // "redeem" | "twitch_event" | "module_switch"
  "ts": "<ISO8601>",
  "channel": { "id": "<broadcaster user_id>", "login": "<login, informational/mutable>" },
  "source": "narya",               // producer; egress trust signal only
  "data": { /* type-specific, field-allowlisted */ }
}
```

- **`id` is derived deterministically from the source event id** (EventSub `message_id`, redemption
  id, chat message id) with a random fallback only where a source genuinely has none. Documented as
  the dedup key external consumers should use across EventSub redelivery.
- **`channel.id` is the immutable `user_id`**; `login` is present but flagged mutable — never a stable
  key.
- **`version` + additive-only** compatibility policy; breaking changes bump the version and are
  announced. Because consumers live outside this repo, the version field replaces Narya's internal
  "trace every consumer" discipline.

### 5.1 Per-type field allowlist (the `OVERLAY_EVENTS` discipline, turned outward)
Per event type, an explicit list of which fields cross to external readers. Viewer **login is
included** (most reactions need it) — an informed-exposure choice the operator makes by configuring
Redis; non-essential PII stays off the wire. There is **no per-type egress toggle** in Phase A —
configuring Redis is the opt-in.

| type | `data` fields |
|---|---|
| `redeem` | `rewardId`, `rewardTitle`, `rewardSource`, `rewardExternalRef`, `redemptionId`, `userId`, `userLogin`, `userInput` |
| `twitch_event` | `eventKind` (follow/sub/gift/cheer/raid…), `actorUserId`, `actorLogin`, `amount?` (bits/months/viewers), `tier?` |
| `module_switch` | `fromModuleId`, `toModuleId`, `categoryId`, `categoryName` |

### 5.2 Durability (stated, not implied)
- Retention pinned in **time, not count**: `XADD` then trim with **`MINID`** against a
  timestamp-derived id for a **~48h rolling window** (not `MAXLEN ~ N`, which collapses to minutes
  during a follow/cheer flood and evicts redeems to unrelated volume).
- The guarantee covers **consumer** downtime only — not publisher downtime and not events emitted
  before Redis was configured (no outbox in v1). Stated plainly so operators don't over-trust it.

## 6. Choke points + dedup (`eventBus.ts`)

`publishNaryaEvent(type, data)` builds the envelope (deterministic `id`, allowlisted `data`) and calls
`redis.xadd`. It is called from **exactly one choke point per source event, placed after the existing
merge/dedup decision** — never per emit branch:
- **Redeems** — in `eventsub.ts`, after the redemption is accepted (same point the reward Action
  dispatch fires), joining `reward_provenance` on `reward_id` for `rewardSource`/`rewardExternalRef`.
- **Twitch events** — in `eventsub.ts`, after the existing `sub_merge_state` suppression, so a resub
  that fires both `channel.subscribe` and `subscription.message` publishes **once**, and the
  `watch_streak` pseudo-redeem never masquerades as a redemption.
- **Module switches** — in `categoryModules.ts`, on a confirmed active-module transition.

A **bus analogue of `redeemOnce.test.ts`** asserts exactly one envelope per real event across
redelivery and sub-merge.

## 7. Reward provenance

`reward_provenance(reward_id PK, source, external_ref, created_at)` — independent of `categoryId`
(a reward can be category "Games" *and* sourced "pztmi").
- The operator's `POST /api/twitch/rewards` writes `source` (`narya` or `manual`); the `DELETE` handler
  clears the provenance row.
- A **self-healing upsert on `fetchRewards`** inserts `source='manual'` for any reward id not yet
  known (rewards born on the Twitch dashboard/mobile). This replaces a one-shot backfill, which can't
  reach the full reward list without a live authed `fetchRewards`.
- **A join miss is `null`, never a fabricated `manual`**, and **a missing provenance row never gates
  dispatch** — the Action still fires; only the envelope's `rewardSource` is null.

### 7.1 Source-assignment UX
Add a per-reward **source/owner selector** to the existing Viewer Rewards management page
(`ViewerRewardsPage.tsx`). Registered apps plus the `narya`/`manual` sentinels populate it; choosing
one upserts `reward_provenance(reward_id, source, external_ref=null, created_at)`. Selecting a source
validates it against `apps` (or the sentinels) server-side.

## 8. Names-only app registry (`apps.ts`)

`apps(id, name, created_at, disabled_at)` + REST CRUD + a Settings section to add/disable apps.
- `narya` and `manual` are **reserved sentinels** (seeded, not real app rows); every other `source`
  string on a reward or envelope validates against `apps`.
- Token/hash columns and minting are **deferred to Phase C/D** — nothing consumes a token in an
  outbound-only slice, so building it now is premature (YAGNI). The `apps` schema is shaped so those
  columns are an additive migration later.
- Disabling an app keeps its provenance rows intact (rewards stay tagged, envelopes keep publishing
  the source string) — full revocation semantics belong to the phases that grant apps capabilities.

## 9. Health signal (operability)

Fire-and-forget makes a dead bus invisible, which violates "how will a production failure be
detected?":
- `redisConnected: boolean` and `lastPublishError: string | null` added to `DashboardStatus`
  (aggregated in `dashboard/status.ts`).
- Connect/drop transitions surface through `ServiceStatusToasts` (`settings:updated` already drives
  it), plus a **persistent inline Settings alert** when `redisConfigured` is true but not connected.

## 10. Contracts (`shared/api.ts`)

Trace every producer/consumer when changing these:
- `NaryaEventEnvelope` + the three `data` shapes (documented public contract).
- `App` (`{ id, name, createdAt, disabledAt }`) + `AppInput`.
- Reward payload gains `source: string | null` and `externalRef: string | null` (from provenance);
  the client rewards service and `ViewerRewardsPage` consume them.
- `DashboardStatus` gains `redisConnected` + `lastPublishError`; the dashboard status consumer renders
  them.
- `AppConfigPublic` gains `redisConfigured`; the Connections settings form binds it.

## 11. Testing strategy

- **Pure unit tests:** envelope build, deterministic `id` derivation, the per-type field allowlist
  (a field not on the list must not cross), source validation against sentinels + registry.
- **Bus double-play guard:** a `redeemOnce.test.ts` analogue — one envelope per real event across
  EventSub redelivery and sub-merge; a throwing/hanging `xadd` port neither delays nor fails the
  redeem path.
- **Ports + DI:** publish tested through an injected `xadd` port (as `redeemOnce.test.ts` mocks
  realtime) — **no live Redis**, in-memory DB under `NODE_ENV=test`.
- **Provenance:** POST writes source; DELETE clears; self-healing upsert inserts `manual` for unknown
  ids; join miss is null and never gates dispatch — all in `*.test.ts` against the in-memory DB, never
  an ad-hoc script against the live DB.
- **Config:** `redisConfigured` reflects presence; `clearRedisUrl` clears; `toPublic` never leaks the
  URL; `redis://|rediss://` validation rejects other schemes.
- **Opt-in integration smoke** gated on an env flag (never runs in the in-memory path): real
  connect/disconnect, publish-while-down, and `MINID` retention. Plus documented manual smoke steps
  after configuring `redisUrl`.

## 12. Rollout / verification

`bun run typecheck`, `bun test`, `bun run build` all green. Manual end-to-end: configure a local
Redis, register `pztmi`, tag a reward `source=pztmi`, redeem it, and observe the envelope on the
stream (`XREAD`/a tiny listener) carrying `type=redeem` + `rewardSource=pztmi`. With `redisUrl`
unset, confirm the full suite and a redeem both behave exactly as before (no-op layer).
