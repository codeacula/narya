# Phase D — external reward provisioning (REST + app token)

**Status:** Approved (design). Implementation plan to follow.
**Date:** 2026-07-24
**Parent arc:** `2026-07-20-redis-automation-arc-design.md` §10. Depends on Phase A only (the `apps` registry + `reward_provenance`, both merged). Independent of C1/C2, which are also merged.

---

## 1. Context & goal

Phase A added a names-only `apps` registry and `reward_provenance` (which app minted which channel-point reward). Phase D lets a registered external app **create and manage its own channel-point rewards over REST**, authenticated by a per-app token, without ever being able to touch another app's rewards — or the operator's.

**Decisions locked in this brainstorm (2026-07-24):**
- **A single app token, no scopes.** C1 settled that inbound events need no token (trust is which Redis stream the event arrived on), so reward provisioning is the only token-gated surface. A scopes list with one value and no second consumer is machinery without a design constraint — add it when a second surface exists.
- **No per-app reward quota.** Rely on Twitch's channel cap. **Consequence, and the core compensating control: because nothing prevents one app consuming the shared pool, the error when Twitch rejects for the cap must attribute consumption per source** (§7). Without a preventive quota this diagnostic *is* the safety net, so it is a first-class requirement, not a nicety.
- **The category coordinator keeps today's behavior** — it toggles rewards by group membership regardless of `source`, so a game switch can disable an app's reward. The app cannot observe that until the deferred `reward.state_changed` egress event exists (arc §13). Documented, not changed.

**Out of scope:** scopes; per-app quotas; a `reward.state_changed` egress event; letting an app read redemptions (that is the inbound path's job); any change to the operator's own reward UI beyond surfacing per-app counts.

## 2. The isolation invariant (the reason this phase is security-critical)

Every reward Phase D creates is minted under Narya's **single Twitch `client_id`** with the **operator's** OAuth token. Twitch's `canManage` / `only_manageable_rewards` therefore returns true for **every** narya-created reward, so **Twitch provides zero isolation between apps**. `canManage` (Twitch, per-client-id) and `source` (provenance, per-app) are independent, and Twitch enforces neither the source boundary nor per-app caps.

Isolation is therefore **one `WHERE` clause, and it is a hard invariant**:

> Every app-facing reward route resolves `source` **from the presented token**, never from the request body or a query parameter, and every read/write runs `WHERE reward_id = ? AND source = ?`, returning **404 on a miss** (not 403 — a miss must not confirm the reward exists).

A `redeemOnce`-style test (`src/server/appRewardIsolation.test.ts`) proves app `foo` cannot GET, PATCH, or DELETE app `pztmi`'s reward, nor a `manual`- or `narya`-sourced one, and that a body-supplied `source` is ignored.

## 3. Auth — a third credential that is mutually exclusive with the other two

`auth.ts` today resolves a presented token to `'operator' | 'overlay' | null` (`roleForToken`), and `requireDashboardToken` is mounted at `/api`.

**App routes live under a distinct prefix: `/api/ext/*`** ("external").

**Deliberately NOT `/api/app/`.** The operator-only app registry already lives at **`/api/apps/`** (`/api/apps/:id/events` from C1), and `'/api/apps/x'.startsWith('/api/app')` is `true` — so a prefix check missing its trailing slash by one character would skip the operator guard on the registry itself, exposing app management to an app token (or to no token at all, if `requireAppToken` were not mounted there). A one-character typo must not be the only thing standing between an app and the operator's registry. `/api/ext/` cannot collide with `/api/apps/` under any prefix comparison, so the whole failure class is designed out rather than guarded against.

- `requireDashboardToken` **skips** paths under `/api/ext/` (a prefix check, not an `EXEMPT_PATHS` exact match — the routes carry `:id` params), delegating to `requireAppToken` mounted on that router. Skipping the operator guard is safe only because `requireAppToken` runs on every one of those routes; the plan wires them together so neither can be registered without the other, and a test asserts an unauthenticated request to every `/api/ext/*` route is rejected.
- **`requireAppToken`** extracts the bearer token, hashes it (`sha256`), looks up `apps.token_hash`, and attaches the resolved app (`id`, `name`) to the request. It rejects with 401 when: no token, no match, or **the app is disabled** (consistent with C1, where a disabled app is dropped from the consumer's read set).
- **Mutual exclusion, both directions, each with a test:**
  - An **app token never satisfies an operator or overlay route.** This already holds structurally — `roleForToken` compares only against `dashboardToken` and the derived overlay token — but it is asserted, not assumed.
  - An **operator or overlay token never satisfies an app route.** The hash lookup would not match them, but `requireAppToken` **also explicitly rejects a token equal to `dashboardToken` or the overlay token** before the lookup. This is defence against the realistic operator error of pasting the dashboard token into an app's config, which must fail closed rather than silently depend on "it happens not to be in the table."
- Token comparison uses the existing constant-time `tokensMatch` idiom for the explicit-rejection check; the hash lookup is a normal indexed equality.

## 4. Token lifecycle

`apps` gains **`token_hash text`** (nullable — an app with no token cannot call the API) via the allowlisted `addColumnIfMissing`. **The plaintext token is never stored and never recoverable.**

- **`POST /api/apps/:id/token`** (operator-only, under the existing dashboard guard — note this is the `/api/apps/` registry, not `/api/ext/`) mints a token: 32 random bytes hex-encoded, prefixed **`narya_app_`** for recognizability in a config file or a leaked log, stores `sha256(plaintext)` in `token_hash`, and returns the plaintext **exactly once** in that response.
- Re-minting **rotates**: the new hash replaces the old, instantly invalidating the previous token. The UI must state that plainly.
- **`DELETE /api/apps/:id/token`** clears `token_hash`, revoking access without deleting the app.
- `App` on the wire gains **`tokenConfigured: boolean`** — never the hash, never the plaintext. This mirrors the established `*Configured` pattern used for every other secret in `appConfig.ts`.
- Deleting or disabling an app must not orphan its rewards on Twitch; provenance rows survive so the operator can still see and clean them up from the existing reward UI.

## 5. App-facing routes (all `source`-scoped from the token)

- **`GET /api/ext/rewards`** — this app's rewards: provenance rows `WHERE source = ?`, joined to live Twitch reward state.
- **`POST /api/ext/rewards`** — create, **idempotent on `(source, external_ref)`** (§6).
- **`PATCH /api/ext/rewards/:id`** — update title/cost/prompt/enabled/etc., `WHERE reward_id = ? AND source = ?`, 404 on miss.
- **`DELETE /api/ext/rewards/:id`** — same scoping, 404 on miss; clears the provenance row on success.

`source` is always the app's **name** resolved from the token (matching how Phase A writes provenance and how `isKnownSource` validates), never client-supplied.

## 6. Idempotency — `UNIQUE(source, external_ref)`

`reward_provenance.external_ref` already exists (Phase A) but is unindexed. Phase D adds:

```sql
create unique index if not exists idx_reward_provenance_source_ref
  on reward_provenance(source, external_ref) where external_ref is not null;
```
The partial predicate matters: existing Phase A rows (`narya`/`manual`) have `external_ref IS NULL`, and SQLite treats NULLs as distinct — but stating `where external_ref is not null` makes the intent explicit and keeps the index small. **No backfill; no data migration.**

`external_ref` is the **app's own idempotency key**. `POST /api/ext/rewards` requires it and:
1. Looks up `(source, external_ref)`. **If a row exists, it returns the existing reward (200) without calling Twitch** — a retried provision must never mint a second Twitch reward and burn cap.
2. Otherwise creates on Twitch, then writes provenance with `(source, external_ref)` in the **same transaction path** as the id it just learned.

The failure ordering is stated deliberately: the Twitch create is the non-transactional step, so if provenance writing fails after a successful create, the reward exists on Twitch un-attributed. That is recoverable (the operator sees it in the reward UI as unsourced) and strictly better than the reverse, which would attribute a reward that does not exist.

## 7. The cap-rejection diagnostic (the compensating control for "no quota")

Twitch's per-channel reward cap is a **shared pool** across manual rewards, Narya-UI rewards, and every app. With no preventive quota, a single app can exhaust it and the *operator's own* reward creation starts failing with an opaque Twitch 400.

Therefore, when a create fails with Twitch's cap error, the response and the operator-visible log must **attribute current consumption per source**, computed from `reward_provenance`:

> `Twitch rejected the reward: the channel's reward limit is reached. Current rewards by source — pztmi: 7, narya: 3, manual: 12.`

A small `rewardCountsBySource()` helper in `rewardProvenance.ts` backs this. **The audience of the breakdown is split three ways** (amended pre-merge — the original "applies to both routes" wording was written without considering cross-app disclosure, and directly contradicts §2's 404-never-403 rationale):

- **The operator's `POST /api/twitch/rewards`** keeps the full per-source breakdown in the response. The operator is the party who has to decide whose rewards to retire, so they need the attribution in the surface they are looking at.
- **The app-facing `POST /api/ext/rewards`** gets a **generic** cap message plus **its own** count, and no other source's name or number: `…the channel's reward limit is reached. This app currently holds 2 of the channel's rewards.` An app holds one token and knows one name; handing it `pztmi: 7, narya: 3, manual: 12` would disclose the operator's entire app registry and every app's consumption to any caller that can hit the cap — the same disclosure a 403 would make, which is why §2 answers 404 instead.
- **The log gets the full breakdown on EVERY create failure**, cap-shaped or not, on both routes. The cap regex is the fragile piece (Twitch renaming its enum silently removes the diagnostic), so the operator's attribution must not depend on it matching. The breakdown is deliberately **not** attached to non-cap 400 responses: duplicate-title is the most common create rejection, and doing so would fire the disclosure constantly instead of at the one moment it is actionable.

Additionally, the **Apps settings page shows a per-app reward count**, so consumption is visible before the cap is hit rather than only at failure. (Same shape as C2's `boundTriggerCount` hint.)

## 8. Schema

- `apps.token_hash text` — via `addColumnIfMissing` + the three allowlists, mirroring C1/C2's additive pattern. Nullable; no backfill.
- `idx_reward_provenance_source_ref` — the partial unique index above.
- **No table rebuild, no data migration.** Existing rows remain valid (`token_hash` null = no token; `external_ref` null = not app-provisioned).

## 9. Operational risks (documented, not fixed here)

- **Changing `appConfig.twitchClientId` strands every provisioned reward.** `canManage` flips false and provenance-backed management starts 403ing, because rewards are only manageable by the client that created them. The operator must be warned; re-deriving `canManage` from a fresh `fetchRewards` on a client-id change is the fix, deferred.
- **A game switch can disable an app's reward** — the coordinator toggles by group membership regardless of `source` (kept, per the decision above), and the app has no way to observe it until `reward.state_changed` exists.
- **A revoked/rotated token breaks a running app immediately.** Rotation is the intended revocation mechanism; the UI says so.

## 10. Testing strategy

- **Isolation (the correctness weight), `appRewardIsolation.test.ts`:** app `foo` cannot GET/PATCH/DELETE app `pztmi`'s reward (404, not 403); cannot touch a `manual`- or `narya`-sourced reward; a body-supplied `source` is ignored in favour of the token's.
- **Auth mutual exclusion:** an app token is rejected on an operator route AND on an overlay route; the operator token and the overlay token are both rejected on an app route (explicitly, not incidentally); a disabled app's token is rejected; a revoked (`token_hash` null) app is rejected; a rotated token invalidates its predecessor.
- **Idempotency:** two POSTs with the same `(source, external_ref)` yield **one** Twitch create and the same reward id; two apps may reuse the same `external_ref` independently (different `source`); a missing `external_ref` is a 400.
- **Cap diagnostic:** a simulated Twitch cap rejection produces per-source counts; `rewardCountsBySource()` counts correctly across `manual`/`narya`/apps.
- **Token lifecycle:** mint returns plaintext once and never again; `tokenConfigured` is exposed but the hash never is; re-mint rotates; delete revokes.
- **Schema:** existing rows read fine with `token_hash` null; the partial unique index permits many NULL `external_ref` rows and rejects a duplicate `(source, external_ref)`.

Twitch calls are exercised through the existing injected-port/fetch-seam idiom — **no test may hit live Twitch** (creating or deleting real channel-point rewards is irreversible).

## 11. Verification

`bun run typecheck`, `bun test`, `bun run build` all green. Manual (opt-in): register an app, mint a token, `curl` a POST with an `external_ref` and confirm one reward appears with the app's provenance; repeat the identical POST and confirm **no second reward** is created; PATCH it with the app token and confirm it changes; attempt the same PATCH against another app's reward id and confirm 404; present the dashboard token to an app route and confirm 401; present the app token to `/api/config` and confirm 401.
