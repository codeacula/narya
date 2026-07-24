# Phase D — external reward provisioning: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a registered external app create and manage **its own** channel-point rewards over REST, authenticated by a per-app token, with no ability to touch another app's rewards or the operator's.

**Architecture:** A third credential (`apps.token_hash`) authenticates a new `/api/ext/*` surface via `requireAppToken`. Isolation is a hard `WHERE reward_id = ? AND source = ?` invariant enforced in every app route, because Twitch provides none. Idempotency rides a partial unique index on `(source, external_ref)`.

**Tech Stack:** Bun, TypeScript (strict), SQLite (`bun:sqlite`), Express, React. Tests are `*.test.ts` colocated; `bun test` uses an in-memory DB under `NODE_ENV=test`.

## Global Constraints

- **Isolation is the phase's reason to exist.** Every app-facing route resolves `source` **from the token**, never from the body or a query param, and every read/write uses `WHERE reward_id = ? AND source = ?`, returning **404 on a miss** (never 403 — a miss must not confirm the reward exists).
- **Twitch enforces nothing here.** Every reward is minted under one `client_id` with the operator's OAuth token, so Twitch's `canManage` is true for *all* narya-created rewards. `canManage` (per-client-id) and `source` (per-app) are independent.
- **The app prefix is `/api/ext/`, never `/api/app/`.** The operator registry is `/api/apps/`, and `'/api/apps/x'.startsWith('/api/app')` is `true` — a prefix check short one character would skip the operator guard on the registry. Do not rename this prefix.
- **Mutual exclusion, both directions:** an app token must never satisfy an operator/overlay route; an operator/overlay token must never satisfy an app route (checked **explicitly**, not left to "it isn't in the table").
- **The plaintext token is never stored and never recoverable.** Only `sha256(plaintext)` is persisted; the plaintext is returned exactly once at mint. The wire carries `tokenConfigured: boolean` only — never the hash, never the plaintext. Never log a token.
- **A disabled app's token is rejected** (consistent with C1, where a disabled app is dropped from the consumer's read set). A revoked (`token_hash` null) app is rejected.
- **No per-app quota** (decided). The compensating control is the cap-rejection diagnostic (Task 6) — it is a requirement, not a nicety.
- **The category coordinator is unchanged** — it keeps toggling rewards by group membership regardless of `source`.
- **No test may hit live Twitch.** Creating or deleting real channel-point rewards is irreversible. Use the existing fetch seam that `viewerRewards.test.ts` already mocks (`REWARDS_URL`, `viewerRewards.ts:20`).
- Additive schema only: `addColumnIfMissing` + a partial index. No table rebuild, no data migration, no backfill.
- `bun run typecheck` green at EVERY commit.

---

### Task 1: schema + token lifecycle

**Files:**
- Modify: `src/server/db.ts` (the `token_hash` column + the partial unique index)
- Modify: `src/server/apps.ts` (mint / revoke, `tokenConfigured` on the wire)
- Modify: `src/shared/api.ts` (`App.tokenConfigured`)
- Test: `src/server/apps.test.ts` (extend)

**Interfaces:**
- Produces: `mintAppToken(appId): string` (returns plaintext ONCE), `revokeAppToken(appId): void`, `findAppByTokenHash(hash): App | null`, and `hashAppToken(plaintext): string`.

**Context:** `addColumnIfMissing(table, column, definition)` (`db.ts:950`) validates the column against **two** allowlists — an identifier Set (~line 871, currently ending `'redis_url','name','conditions_json'`) **and** `allowedMigrationDefinitions` (~875, column → definition, compared lowercased). A new column needs an entry in BOTH or the migration throws. `apps` is `(id, name, created_at, disabled_at)` (`db.ts:657`). `reward_provenance` is `(reward_id pk, source, external_ref, created_at)` (`db.ts:684`).

- [ ] **Step 1: Write the failing test** — in `src/server/apps.test.ts`:

```ts
test('an app starts with no token and reports tokenConfigured false', () => {
  const app = createApp('tokenapp');
  expect(app.tokenConfigured).toBe(false);
  expect((app as unknown as Record<string, unknown>)['tokenHash']).toBeUndefined();
});

test('minting returns a plaintext token once and only stores its hash', () => {
  const app = createApp('mintapp');
  const token = mintAppToken(app.id);
  expect(token).toMatch(/^narya_app_[0-9a-f]{64}$/);
  // The plaintext is never recoverable from the registry.
  const listed = listApps().find(a => a.id === app.id)!;
  expect(listed.tokenConfigured).toBe(true);
  expect(JSON.stringify(listed)).not.toContain(token);
  // The stored value is the hash, not the token.
  expect(findAppByTokenHash(hashAppToken(token))?.id).toBe(app.id);
  expect(findAppByTokenHash(token)).toBeNull();
});

test('re-minting rotates: the previous token stops resolving', () => {
  const app = createApp('rotateapp');
  const first = mintAppToken(app.id);
  const second = mintAppToken(app.id);
  expect(second).not.toBe(first);
  expect(findAppByTokenHash(hashAppToken(first))).toBeNull();
  expect(findAppByTokenHash(hashAppToken(second))?.id).toBe(app.id);
});

test('revoking clears the token', () => {
  const app = createApp('revokeapp');
  const token = mintAppToken(app.id);
  revokeAppToken(app.id);
  expect(findAppByTokenHash(hashAppToken(token))).toBeNull();
  expect(listApps().find(a => a.id === app.id)!.tokenConfigured).toBe(false);
});

test('the partial unique index rejects a duplicate (source, external_ref) but allows many nulls', () => {
  // Two null external_refs for the same source are fine (Phase A rows look like this).
  setRewardSource('r1', 'narya');
  setRewardSource('r2', 'narya');
  // A duplicate (source, external_ref) is rejected.
  setRewardSourceWithRef('r3', 'appx', 'ext-1');
  expect(() => setRewardSourceWithRef('r4', 'appx', 'ext-1')).toThrow();
  // The same external_ref under a DIFFERENT source is independent.
  expect(() => setRewardSourceWithRef('r5', 'appy', 'ext-1')).not.toThrow();
});
```
(Use whatever provenance writer Task 3 will formalize; for this task a direct `db.prepare` insert is fine if `setRewardSourceWithRef` does not exist yet — the point is proving the index.)

- [ ] **Step 2: Run to verify it fails**

Run: `bun test src/server/apps.test.ts` — FAIL (`mintAppToken` undefined, no `tokenConfigured`).

- [ ] **Step 3: Implement**

`src/server/db.ts` — add `'token_hash'` to the migration identifier allowlist Set (~871) AND `token_hash: 'text'` to `allowedMigrationDefinitions` (~875), then:

```ts
// A per-app API token for /api/ext/* (Phase D). Only the sha256 of the token is
// stored — the plaintext is shown once at mint and is never recoverable. Null means
// the app has no token and cannot call the API.
addColumnIfMissing('apps', 'token_hash', 'text');
```
and, next to the other index statements:
```sql
-- Phase D idempotency: an app's external_ref is its own key, so a retried provision
-- returns the existing reward instead of minting a second one and burning the
-- channel's shared reward cap. Partial, because Phase A rows (narya/manual) have a
-- null external_ref and many such rows per source are legitimate.
create unique index if not exists idx_reward_provenance_source_ref
  on reward_provenance(source, external_ref) where external_ref is not null;
```

`src/shared/api.ts` — `App` gains `tokenConfigured: boolean` (mirrors the `*Configured` pattern used for every other secret; the hash and plaintext never reach the wire).

`src/server/apps.ts` — map rows through a `rowToApp` that derives `tokenConfigured: Boolean(row.tokenHash)` and **omits** `tokenHash`, then:

```ts
const TOKEN_PREFIX = 'narya_app_';

/** sha256 of the plaintext token. Only this is ever persisted. */
export function hashAppToken(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

/** Mint (or rotate) an app's token. Returns the plaintext EXACTLY once — it is not
 *  stored and cannot be recovered. Rotating instantly invalidates the previous token. */
export function mintAppToken(appId: string): string {
  if (!appExistsById(appId)) throw new HttpRouteError(404, 'App not found.');
  const plaintext = `${TOKEN_PREFIX}${randomBytes(32).toString('hex')}`;
  setTokenHash.run(hashAppToken(plaintext), appId);
  return plaintext;
}

export function revokeAppToken(appId: string): void {
  setTokenHash.run(null, appId);
}

/** Resolve a token HASH to its app. Callers hash first — never pass a plaintext. */
export function findAppByTokenHash(tokenHash: string): App | null {
  const row = getAppByTokenHash.get(tokenHash) as AppRow | undefined;
  return row ? rowToApp(row) : null;
}
```
Routes (operator-only, under the existing dashboard guard — this is `/api/apps/`, NOT `/api/ext/`):
`POST /api/apps/:id/token` → `{ token: mintAppToken(id) }`; `DELETE /api/apps/:id/token` → 204.

- [ ] **Step 4: Run to verify it passes**

Run: `bun test src/server/apps.test.ts` and `bun run typecheck` — green.

- [ ] **Step 5: Commit**

```bash
git add src/server/db.ts src/server/apps.ts src/shared/api.ts src/server/apps.test.ts
git commit -m "feat: per-app API token (hashed, mint-once) + provenance idempotency index"
```

---

### Task 2: `requireAppToken` + mutual exclusion

**Files:**
- Modify: `src/server/auth.ts` (the `/api/ext/` skip + `requireAppToken`)
- Test: `src/server/auth.test.ts` (extend)

**Interfaces:**
- Consumes: `findAppByTokenHash`, `hashAppToken` (Task 1).
- Produces: `requireAppToken` (Express middleware attaching the resolved app), `APP_API_PREFIX = '/api/ext/'`.

**Context:** `requireDashboardToken` (`auth.ts:115`) is mounted at `/api` and reconstructs `request.baseUrl + request.path`. `roleForToken` (`:101`) resolves only operator/overlay. `extractToken` (`:75`) reads `Authorization: Bearer`. `tokensMatch` (`:89`) is the constant-time compare. `getOverlayToken()` (`:66`).

- [ ] **Step 1: Write the failing test** — in `src/server/auth.test.ts`:
- An app token is rejected on an operator route (401) and on an overlay route.
- **The operator token is rejected by `requireAppToken`**, and so is the overlay token — explicitly, even though neither is in `apps.token_hash`.
- A valid app token resolves to its app.
- A **disabled** app's token is rejected.
- A **revoked** app (`token_hash` null) is rejected; a null/empty presented token never matches a null `token_hash`.
- `requireDashboardToken` skips `/api/ext/...` (so `requireAppToken` can run) but does **NOT** skip `/api/apps/...` — assert the registry still requires the operator token. This is the one-character-prefix trap; cover it explicitly.

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement** — in `src/server/auth.ts`:

```ts
// The app-token surface. Deliberately NOT '/api/app/': the operator registry is
// '/api/apps/', and '/api/apps/x'.startsWith('/api/app') is true, so a prefix check
// short one character would skip the operator guard on the registry itself.
export const APP_API_PREFIX = '/api/ext/';
```
In `requireDashboardToken`, before the role check:
```ts
  // Delegated to requireAppToken, which is mounted on every /api/ext/* route.
  // Skipping here is safe ONLY because of that — the two are registered together.
  if (fullPath.startsWith(APP_API_PREFIX)) {
    next();
    return;
  }
```
And the new middleware:
```ts
/**
 * Guards /api/ext/*. A presented token resolves to a registered, enabled app or the
 * request is refused. An operator or overlay token is rejected EXPLICITLY rather than
 * incidentally: pasting the dashboard token into an app's config is a realistic
 * operator error, and it must fail closed instead of depending on that token happening
 * not to be in apps.token_hash.
 */
export function requireAppToken(request, response, next) {
  const provided = extractToken(request);
  if (!provided) {
    response.status(401).json({ error: 'Unauthorized' });
    return;
  }
  if (config.dashboardToken && tokensMatch(provided, config.dashboardToken)) {
    response.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const overlay = getOverlayToken();
  if (overlay && tokensMatch(provided, overlay)) {
    response.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const app = findAppByTokenHash(hashAppToken(provided));
  if (!app || app.disabledAt) {
    response.status(401).json({ error: 'Unauthorized' });
    return;
  }
  (request as AppAuthedRequest).app = app;
  next();
}
```
Never include the presented token in a response or log line.

- [ ] **Step 4: Run to verify it passes** — `bun test src/server/auth.test.ts` + `bun run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add src/server/auth.ts src/server/auth.test.ts
git commit -m "feat: requireAppToken guarding /api/ext, mutually exclusive with operator/overlay"
```

---

### Task 3: provenance helpers for scoping, idempotency, and counts

**Files:**
- Modify: `src/server/rewardProvenance.ts`
- Test: `src/server/rewardProvenance.test.ts` (create or extend)

**Interfaces:** Produces `listRewardIdsBySource(source): string[]`, `findRewardByExternalRef(source, externalRef): string | null`, `setRewardSourceWithRef(rewardId, source, externalRef)`, `rewardCountsBySource(): Record<string, number>`, `ownsReward(rewardId, source): boolean`.

**Context:** `rewardProvenance.ts` currently has `getRewardSource`, `setRewardSource`, `ensureManualProvenance`, `clearRewardSource` over `reward_provenance(reward_id pk, source, external_ref, created_at)`.

- [ ] **Step 1: Write the failing test** — `ownsReward` is true only for the exact `(reward_id, source)` pair and false for another app, for `manual`, and for an unknown id; `findRewardByExternalRef` scopes by source (the same `external_ref` under two sources resolves independently); `rewardCountsBySource` counts per source across `manual`/`narya`/apps and omits nothing.

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement** — straightforward prepared statements. `ownsReward` is the primitive the isolation invariant is built from:
```ts
/** The isolation primitive: true only when this exact reward is attributed to this
 *  exact source. Every /api/ext/ route gates on it, because Twitch cannot — every
 *  narya-created reward is manageable by our single client_id regardless of app. */
export function ownsReward(rewardId: string, source: string): boolean {
  return Boolean(ownsRow.get(rewardId, source));
}
```

- [ ] **Step 4: Run to verify it passes** — scoped test + `bun run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add src/server/rewardProvenance.ts src/server/rewardProvenance.test.ts
git commit -m "feat: provenance scoping, external_ref lookup, and per-source counts"
```

---

### Task 4: the `/api/ext/rewards` routes

**Files:**
- Create: `src/server/appRewards.ts` (routes + registration)
- Modify: `src/server/index.ts` (register with `requireAppToken`)
- Test: `src/server/appRewards.test.ts`

**Interfaces:** Consumes Tasks 1-3 plus `viewerRewards.ts`'s existing Twitch reward calls (`REWARDS_URL`, `viewerRewards.ts:20`) — **reuse them; do not duplicate the Twitch fetch logic.**

- [ ] **Step 1: Write the failing test** — mock the Twitch fetch the way `viewerRewards.test.ts` already does (match on `url.pathname === '/helix/channel_points/custom_rewards'`), then assert:
- `GET /api/ext/rewards` returns only this app's rewards.
- `POST` with a new `external_ref` creates one Twitch reward and writes provenance with the ref.
- **`POST` repeated with the same `external_ref` performs NO second Twitch create and returns the same reward id** (count the mock's create calls — this is the cap-burning failure the index exists to prevent).
- `POST` without an `external_ref` is a 400.
- `PATCH`/`DELETE` on this app's reward succeed; on another app's reward return **404**.
- A body-supplied `source` is ignored (the token's app wins).

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement** — every handler starts by resolving `const source = request.app.name` from the token (never the body), and every by-id route gates on `ownsReward(id, source)` → 404 when false. `POST` order: look up `(source, external_ref)` → if found, return the existing reward **without calling Twitch**; else create on Twitch, then `setRewardSourceWithRef`. Register the router in `index.ts` mounted with `requireAppToken` so the guard cannot be omitted.

- [ ] **Step 4: Run to verify it passes** — `bun test src/server/appRewards.test.ts` + `bun run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add src/server/appRewards.ts src/server/index.ts src/server/appRewards.test.ts
git commit -m "feat: /api/ext/rewards CRUD, source-scoped and idempotent"
```

---

### Task 5: the adversarial isolation suite

**Files:**
- Create: `src/server/appRewardIsolation.test.ts`

**Context:** This is Phase D's `redeemOnce.test.ts` — a standing proof of the one invariant the phase exists to hold. It is deliberately its own file so it reads as a security proof rather than incidental coverage.

- [ ] **Step 1: Write the tests** (they should PASS against Task 4 — this task proves the invariant, it does not add behavior; if any fails, that is a real finding to fix):
- App `foo` cannot GET, PATCH, or DELETE app `pztmi`'s reward → 404 (never 403, and never the reward's contents).
- App `foo` cannot touch a `manual`- or `narya`-sourced reward.
- A body-supplied `source: 'pztmi'` on `foo`'s token does not re-attribute or grant access.
- **Every** `/api/ext/*` route rejects an unauthenticated request (enumerate them, so a future route added without the guard fails this test).
- The operator token and the overlay token are both rejected on `/api/ext/*`; an app token is rejected on `/api/apps/*` and `/api/config`.
- A disabled app's token is rejected on every route.

- [ ] **Step 2: Run** — all pass. Any failure is a defect in Task 4, not in the test.

- [ ] **Step 3: Commit**

```bash
git add src/server/appRewardIsolation.test.ts
git commit -m "test: prove per-app reward isolation across sources and credentials"
```

---

### Task 6: cap-rejection diagnostic

**Files:**
- Modify: `src/server/appRewards.ts` and `src/server/viewerRewards.ts` (both create paths)
- Test: extend the relevant suite

**Context:** With no per-app quota (decided), this diagnostic is the compensating control. Twitch's cap is a shared pool across manual, Narya-UI, and every app, so an opaque 400 leaves the operator unable to see who consumed it.

- [ ] **Step 1: Write the failing test** — a mocked Twitch create returning the cap error produces a message naming per-source counts (e.g. contains `pztmi: 7`), on **both** the app route and the operator's `POST /api/twitch/rewards`.

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement** — on a cap-shaped Twitch rejection, build the message from `rewardCountsBySource()`:
> `Twitch rejected the reward: the channel's reward limit is reached. Current rewards by source — pztmi: 7, narya: 3, manual: 12.`

Keep the underlying Twitch error available for logs; do not swallow it.

- [ ] **Step 4: Run to verify it passes.**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat: attribute reward consumption per source when Twitch rejects for the cap"
```

---

### Task 7: Apps page — token management + reward count

**Files:**
- Modify: `src/client/services/dashboard.ts`, `src/client/pages/settings/AppsPage.tsx`
- Modify: `src/server/apps.ts` (expose a per-app reward count on the apps list)
- Test: `src/server/apps.test.ts` (extend for the count)

- [ ] **Step 1: Write the failing test** — the apps list reports each app's reward count (0 for a new app, N after provenance rows exist).

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement**
- `dashboard.ts`: `mintAppToken(id)`, `revokeAppToken(id)` (mirror `setAppDisabled`'s `encodeURIComponent` idiom).
- `AppsPage.tsx`: per app, show `tokenConfigured`; a **Mint / Rotate** button that displays the returned plaintext **once**, with copy affordance and explicit copy that it will not be shown again and that rotating **immediately invalidates the previous token**; a **Revoke** button. Never render a token after its initial response — do not stash it in component state beyond the visible panel, and never log it.
- Show the per-app reward count (same shape as C2's `boundTriggerCount` hint) so consumption is visible before the cap is hit.

- [ ] **Step 4: Run to verify it passes** — `bun test`, `bun run typecheck`, `bun run build`.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat: app token management and reward count on the Apps page"
```

---

## Final verification

- [ ] `bun run typecheck` · `bun test` · `bun run build` — all green.
- [ ] Manual (opt-in, no live Twitch writes unless the operator chooses): mint a token; POST a reward with an `external_ref`; repeat the identical POST and confirm **no second reward**; PATCH with the app token; PATCH another app's reward id → 404; dashboard token → `/api/ext/rewards` → 401; app token → `/api/config` → 401.

## Spec coverage self-check

| Spec section | Task |
|---|---|
| §2 isolation invariant | 3, 4, 5 |
| §3 auth + mutual exclusion + `/api/ext/` prefix | 2, 5 |
| §4 token lifecycle | 1, 7 |
| §5 app-facing routes | 4 |
| §6 idempotency / `UNIQUE(source, external_ref)` | 1, 4 |
| §7 cap diagnostic + per-app count | 6, 7 |
| §8 schema | 1 |
| §9 operational risks | documented in spec; no code |
| §10 testing strategy | 1-7 |
