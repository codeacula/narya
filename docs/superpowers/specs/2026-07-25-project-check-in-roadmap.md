# Project Check-In & Roadmap — 2026-07-25

Status: Active roadmap (supersedes `2026-07-23-project-check-in-roadmap.md`)
Author: Codeacula (with Claude)

## Context

Post-Redis-arc health check. Method: seven parallel read-only surveyors (docs reconciliation,
recorded arc follow-ups, infrastructure, code health, security posture, frontend/UX, feature gaps),
each candidate then adversarially verified against the current tree before landing here.
83 raw candidates → 75 confirmed still-open, 8 refuted as already-done or speculative.

## Health snapshot

`main` is clean and pushed. `bun test` → 1591 pass / 3 skip / 0 fail across 84 files.
`bun run typecheck` clean. 0 TODO/FIXME/HACK in `src/`. The Redis automation arc A→B1→B2→C1→C2→D
is fully merged.

**Blocking: none.** The three `should-fix` bugs (deleteAction cascade, `external_ref` carryover,
app PATCH group clamp) all require a specific operator action to trigger and are recoverable.

## Recommended next: Workstream 1

**1 beats 3** because it retires three silent, operator-triggered data-loss paths for roughly a day
of work, and every one is reachable from a single click in the existing UI. Workstream 3 (inbound
Redis recovery) is a bigger correctness win in principle — but the whole inbound consumer is gated
off by default (`STREAMER_TOOLS_CONSUME_INBOUND` is not set), so its failure modes are unreachable
on the live box today. Fix the things that can bite this stream first.

---

## 1. Destructive-action safety (operator data loss)

**Effort: small–medium.** Protects: operator configuration and durable identifiers survive a single click.

| Item | Evidence |
|---|---|
| `deleteAction` cascade-deletes triggers + their per-viewer overrides when the deleted Action is a trigger's *first* action; blast radius depends on list position | `src/server/actions.ts:514-517` (bare DELETE), `src/server/db.ts:606` (`on delete cascade`), `db.ts:634` (second cascade to `trigger_overrides`), `src/client/pages/settings/ActionsPage.tsx:800` (confirm says "will stop firing", not "will be erased"). Precedent for the guard already exists at `src/server/mediaAssets.ts:204-210` (409 "Disable it instead of deleting it") |
| Quote delete has no confirm; `quote_sequence` never reuses a number, so quote 12 is retired permanently while circulating in Discord | `src/client/pages/settings/QuotesPage.tsx:98` (unguarded, adjacent to Edit), `src/server/quotes.ts:187-189` (unguarded hard delete), `quotes.ts:235` (flush *anonymizes* rather than deletes — the invariant this defeats) |
| Counter delete has no confirm (orphaning claim refuted — `counters.ts:337-350` throws 409 when referenced; residual is loss of an unreferenced tally) | `src/client/pages/settings/CountersPage.tsx:180-191`, `:312-319` |
| Rotate/Revoke app token are unguarded single clicks; plaintext unrecoverable, app name unrenameable | `src/client/pages/settings/AppsPage.tsx:143-175`, buttons at `:205-214` (Rotate occupies the same coordinates as the harmless Mint), `src/server/apps.ts:84-97` |

Eight `window.confirm` sites already establish the idiom (`AutomationPage.tsx:1477`,
`ActionsPage.tsx:800`, `ModulesPage.tsx:257`, `ViewerRewardsPage.tsx:692`/`:821`,
`ContentSection.tsx:187`/`:570`, `StreamCategoriesPage.tsx:300`). Quotes, Counters, and Apps are the
only destructive deletes without one.

---

## 2. Reward provenance & app/operator boundary correctness

**Effort: small.** Protects: the app idempotency contract and the operator's authority over reward groups.

| Item | Evidence |
|---|---|
| Re-tagging a reward's source leaves the previous owner's `external_ref` attached under the new source — breaks idempotency (app re-mints from the capped pool), mis-attributes the ref, and can throw a bare 500 *after* the Twitch write landed. Reproduced in isolated SQLite | `src/server/rewardProvenance.ts:6-10` (`on conflict` omits `external_ref`; sibling `upsertWithRef` at `:27-31` does update it), `:39-42`, `src/server/viewerRewards.ts:616`, `src/server/db.ts:1145-1146` (unique index) |
| App PATCH sends `reward.isEnabled` straight through with no reward-group lookup; the operator's own PATCH clamps it. An app can re-enable a reward the category coordinator just stood down | `src/server/appRewards.ts:209` vs `src/server/viewerRewards.ts:607` (`category?.enabled === 0 ? false : …`); coordinator at `categoryModules.ts:523` → `viewerRewards.ts:447-464` (no source filter). Same boundary the file already enforces for `categoryId` at `appRewards.ts:115-118` |
| Optional companion: warn on Twitch client-ID change — it invalidates the whole OAuth session, not just reward manageability (`canManage` re-derive is already satisfied by construction) | `src/client/pages/settings/ConnectionsSection.tsx:214-221` (bare field, no note), `src/server/twitch/api.ts:44`, `src/server/index.ts:79-83` |

---

## 3. Inbound Redis consumer recovery

**Effort: small–medium.** Protects: at-least-once inbound delivery survives a broker restart or reconnect.

One root cause, three symptoms — `preparedApps` is never invalidated on recovery.

| Item | Evidence |
|---|---|
| NOGROUP death loop: group creation is one-shot; after a broker restart without persistence, XREADGROUP returns NOGROUP forever, logging every 2s. Dashboard shows Redis *green* (it reports the publish client) | `src/server/redisInbound.ts:261-268` (one-shot gate), `:314-322` (unclassified catch + 2s backoff), `:156-159` (`isBusyGroup` is the only classifier — no NOGROUP peer), `src/server/dashboard/status.ts:396` |
| `claimPending`/XAUTOCLAIM never re-runs on an in-process ioredis reconnect, so crash-recovery of the PEL never happens until restart. `handleEntry`'s own comment at `:216-219` promises recovery that does not exist | `redisInbound.ts:228-244`, `:267`, `:343` (only an `error` handler, no `ready`/`close`) |
| Poison-key wedge: `prepareApps` rethrows out of the whole loop, so one app's bad key stops reads for *every* app. XREADGROUP batches all streams into one command | `redisInbound.ts:254-273`, `:298`, `:307-312`. Reproduced with injected fakes: healthy app's group created, `xreadgroup` calls = 0 |
| Unbounded envelope `id` becomes `automation_runs.dedupe_key` — the 16 KB cap measures `data` only. Reproduced: a 4 MB `id` dispatched | `redisInbound.ts:58-65`, `:92-99`, `:107`; `triggerDispatcher.ts:273-275`; `db.ts:693`. The identical bug class was fixed one commit earlier for data keys (`appEventCatalog.ts:24-27`) |
| No test coverage for any of it — the smoke suite is `describe.skip` with one happy-path test; `__setRedisInboundClientFactory` (`redis.ts:114`) is an existing unused seam that closes most of it with no broker | `src/server/redisInboundSmoke.test.ts:35`, `:97-129`; spec required this at `docs/superpowers/specs/2026-07-20-redis-automation-arc-design.md:404` |

The fix must clear `preparedApps` (so XGROUP CREATE retries too), and must decide `'$'` vs `'0'` on
recreation — `'$'` silently skips anything published while the group was gone.

---

## 4. Redis/apps discoverability (the shipped-but-invisible feature)

**Effort: small.** Protects: an operator can actually turn on and debug a feature that shipped.

| Item | Evidence |
|---|---|
| `STREAMER_TOOLS_CONSUME_INBOUND` — the master switch for all of Phase C1/C2 — appears in no `.env.example`, README, or CLAUDE.md, while all three assert a *closed* list of env vars. Without it, `startRedisInbound()` is a silent no-op with no log | `src/server/config.ts:40`, `src/server/redisInbound.ts:333`, `.env.example:14`, `README.md:104-113`, `CLAUDE.md:346` |
| `STREAMER_TOOLS_REDIS_PREFIX` undocumented, and the `?? NODE_ENV ?? 'prod'` fallback drifts: `NODE_ENV=production` in the `.env` the README tells you to create silently moves every stream key. XGROUP MKSTREAM *creates* the wrong-key stream rather than erroring | `src/server/redis.ts:23-25`, `package.json:12` vs `:13`. Fix must normalize, not remove — `redis.test.ts:114-118` and `eventBus.test.ts:52-60` depend on `test` |
| The per-app inbound stream key `narya:<prefix>:inbound:<appId>` is never shown anywhere; `appId` is a `crypto.randomUUID()` the Apps page never renders | `src/server/apps.ts:59`, `src/server/redis.ts:28-30`, `src/client/pages/settings/AppsPage.tsx` (app.id used only as a React key) |
| No inbound health surface at all — `DashboardStatus` carries only publish-side `redisConnected`/`lastPublishError`; a publish failure while *connected* is invisible in the UI entirely | `src/shared/api.ts:210-211`, `src/server/redis.ts:95-104` (sets `lastPublishError` without clearing `connected`), `src/client/ui/serviceStatus.tsx:16`,`:39-44` (transition-only, skips first snapshot) |
| README documents a dead env var (`MUSIC_PLAYERCTL_PLAYER`, read nowhere), omits 6 live overlay routes, and has no build/deploy/test section | `README.md:33`, `:24-26` vs `src/client/routing.ts:44-63`; `package.json:13-14` + `src/server/static.ts:10-17` |

---

## 5. Automation contract gaps (things the UI advertises that don't work)

**Effort: small–medium.** Protects: what the editor shows an operator matches what runs.

| Item | Evidence |
|---|---|
| `{category}` and `{module}` are advertised on every step template, documented in `TemplateContext`, resolved as known tokens — and set by **no** dispatch path except module lifecycle. They render empty | `src/client/pages/settings/ActionsPage.tsx:47`, `src/shared/api.ts:1060-1062`, `src/server/actionTemplates.ts:43-44`; all context builders at `triggerDispatcher.ts:402`,`:414`,`:424-430`,`:441-445`,`:457-462`,`:607-613` — only `:478` sets `module`. Fix needs `coordinator.activeGameName` (`categoryModules.ts:255`), not just `getActiveModuleId` |
| Test on a `redis_event` trigger runs with `enforceGates: false` and **no** `allowedStepTypes`, so it executes steps production skips — and `obs_scene` (`actionExecutor.ts:302-304`) actually switches the live scene. Client also posts `{}`, so `{data.*}` always renders empty | `triggerDispatcher.ts:301`,`:451` vs `:632-644`; `src/client/services/dashboard.ts:739-741`. Spec required keying on `trigger.kind` (`phase-c1-inbound-triggers-design.md:63`), implementation keys on call site |
| Conditions editor renders a full builder for `manual`/`module_activate`/`module_deactivate`, which dispatch with `enforceGates: false` — an operator can save a filter that is unconditionally ignored. Fix is hide/warn, **not** enforce (contexts are empty, enforcing would fail closed) | `AutomationPage.tsx:1222-1234` (no guard, while `:1285`/`:1287` guard the adjacent sections), `triggerDispatcher.ts:310`,`:486`,`:638` |
| `CONDITIONS_UNREADABLE` is a frozen `[]`, indistinguishable from "no filter" on the wire; any unrelated save persists `'[]'` and permanently opens a fail-closed trigger. Precondition needs out-of-app DB mutation | `src/server/triggerConditions.ts:6`, `automationTriggers.ts:386-393`, `src/shared/api.ts:1201-1209`, `AutomationPage.tsx:965-967` |
| `show_text` renders `{data.*}` uncapped to the overlay (up to a 16 KB banner for up to 60s). `tts_speak` and `send_chat` are already bounded — one line at `actionTemplates.ts:73` | `actionTemplates.ts:73` vs `:77`; `actionExecutor.ts:226-237`; `auth.ts:61`; `styles.css:1155-1178` (no max-height) |

---

## 6. UI honesty on failed loads and stale state

**Effort: small.** Protects: the operator is never told "nothing here" when the truth is "we couldn't ask."

| Item | Evidence |
|---|---|
| `AppsPage` renders "Could not load apps" + "No apps registered yet" + "0 apps registered" simultaneously on a failed fetch. Same in `AppEventsList`. The same pattern exists at `AutomationPage.tsx:1589`, `QuotesPage.tsx:222`, `CountersPage.tsx:324`, `ActionsPage.tsx:849` — fix consistently | `src/client/pages/settings/AppsPage.tsx:256-264`, `:301`, `:331-336`, `:33-41` |
| A reward tagged to a since-disabled app binds a `<select>` to a value with no matching `<option>` — blank control next to a provenance badge showing the real source. `AutomationPage.tsx:332-334` already guards this exact case | `src/client/pages/ViewerRewardsPage.tsx:619`, `:393-404`, `:369` |
| Apps page shows nothing when Redis is down. Needs the inbound gate on `DashboardStatus` first — `redisConnected` alone would be misleading (publish client only) | `SettingsShell.tsx:92` (only body case with no `status`), `:135-144` |
| Inert `redis_event` triggers only badge after you open them (the undeclared-event reason is cache-gated). Two of three inert reasons already badge on fresh load | `AutomationPage.tsx:1382`,`:1404-1408`; `settings/automation.ts:187-193` |
| App-name validation is a 400 round-trip; `MyApp` silently becomes `myapp` on an unrenameable value. `previewCounterKey` is the pattern | `AppsPage.tsx:323`, `:109`; `src/server/apps.ts:47-54`; `CountersPage.tsx:59`,`:193`,`:267` |

---

## 7. Docs & spec-status reconciliation

**Effort: small.** Protects: a future reader (human or agent) doesn't plan from headers claiming shipped work is unbuilt.

- **10** stale `Status:` lines across specs (4 dated specs at `:4`, 6 Redis phase specs at `:3`), all
  describing merged work — `quick-disable-media-mute`, `counter-system`, `stream-wind-down`,
  `llm-action-context`, and phases A/B1/B2/C1/C2/D.
- The 2026-07-23 roadmap was worse than the headers it flagged; superseded by this document.
- `.claude/plans/feature-validation.md` (gitignored scratch) still lists the fixed `/settings`
  routing gap as broken. Correct line 43, stamp superseded, or delete.
- **CLAUDE.md's architecture map contains zero mentions of Redis** and omits `redis.ts`,
  `redisInbound.ts`, `eventBus.ts`, `apps.ts`, `appRewards.ts`, `appEventCatalog.ts`. Worth a pass
  alongside this workstream.

---

## 8. Testing infrastructure

**Effort: small (CI) / medium (coverage).** Protects: regressions can't land unnoticed.

| Item | Evidence |
|---|---|
| **No CI at all.** Verified reproducible in a pristine clone with no `.env`/`data`/`public`/Redis/Twitch: install 0.13s, typecheck clean, 1591 pass in 1.79s, build 6.1s. Also hermetic under `unshare -rn`. The old media blocker is fixed (`src/server/__fixtures__/media/`, `testSetup.ts:16`). **Pin Bun 1.3.x, not the stale `packageManager: bun@1.2.0`** — `bun.lock:3` has `configVersion: 1`, which 1.2.0 cannot parse | no `.forgejo`/`.github`/YAML tracked; `git ls-files` = 309 files |
| `dashboard/status.ts` (744 lines): 7 of 8 exports untested, including 9 routes and the mutating profile PATCH. `normalizeViewerProfileBody` (`:76-100`) enforces four limits nothing asserts. Also 4× duplicated `chat_messages` column list (`:531-546`, `:557-571`, `:610-621`, `:622-632`) | `status.test.ts` is 14 lines (2 typeof assertions); `sessionShoutouts.test.ts` covers 1 export |
| `viewers.ts` role routes: 4 privilege mutations + a pagination loop whose own comment describes a grant/revoke UI inversion (already fixed once) have zero tests. Stub harness exists at `viewerRewards.test.ts:25-36` | no `src/server/viewers.test.ts` |
| Mis-titled test actively suppresses a gap: `"role_is and tag_has are only valid on chat kinds"` never constructs a `tag_has` | `src/server/automationTriggers.test.ts:426`, body at `:431`/`:436` both use `role_is` |
| Unpinned: `MAX_EXTERNAL_REF_LENGTH` (no over-length test), the `hasOwnProperty` check in `mergeDataCatalog` (a `!== undefined` mutant survives; measured +11 key overrun) | `appRewards.ts:89`,`:106-113`; `appEventCatalog.ts:78` |

---

## 9. Code hygiene (batch when touching adjacent files)

**Effort: small each.** No reachable failure modes.

- **Dead client cluster**: 4 `/api/chatbot/commands` service functions + 6 shared types with no
  server route and no callers. *Keep* `legacyMigration.ts` and the DB tables.
  `src/client/services/dashboard.ts:391-405`, `:53-54`; `src/shared/api.ts:438-472`
- **Free tsc flags**: `noUnusedParameters`, `noFallthroughCasesInSwitch`, `noImplicitOverride` all
  report **0** errors today. `noUnusedLocals` = 19 (includes real dead state at `Chat.tsx:182`).
  The linter question is a separate operator decision.
- **~15 orphaned CSS rules** (`alert-*`, `command-action-summary`, `reward-media-missing`,
  `.col-stack.s2/s3/s2-top-auto`, `.ctrl-status`, `@keyframes alertIn`). Two claimed items are
  comments, not rules.
- **Dead exports, re-scoped**: only 3 are cleanly dead (`findCounter`, `hasRunMigration`,
  `DASHBOARD_STATUS_REFRESH_MS`). Four (`AppInput`, `AppEventInput`, `StreamStatusUpdate`,
  `IconName`) should be *used* per CLAUDE.md's contract rule, not deleted.
  **Keep** `__setRedisInboundClientFactory` — Workstream 3 needs it.
- `listSelectableSources()` (`apps.ts:105-108`) has no route; the client reimplements it. Deleting it
  also deletes the only test pinning the disabled-app rule.
- Tag-chip editor duplicated across 4 call sites, already drifted (`LlmStepFields.tsx:52` omits
  `size={11}`, so a 16px glyph overflows a 14px button).
- `/tablet/anything` and `/viewer` bypass `routing.ts` via literal equality and fall through to the
  dashboard. Lower stakes than `/overlay/alerts` — both are behind `AuthGate`.
- `/settings/apps` missing from the routing test's hand-maintained table. **The real unguarded
  structure is `SETTINGS_ROUTES` (`routing.ts:108-110`)**, not `PATH_BY_ROUTE` (which is
  exhaustiveness-checked). A section missing there renders the *cockpit dashboard* at its settings URL.
- Vite/`@vitejs/plugin-react`/`concurrently` (+ react, react-dom) in `dependencies` while
  `typescript` is in `devDependencies`.

---

## 10. Feature gaps (build when wanted, not to retire risk)

Ranked by value-per-effort:

1. **`run_ad` Action step** — small. `runTwitchCommercial` already exists with self-dedupe and a REST
   route; needs 6 registry entries + an executor case. **Must stay out of `REDIS_SAFE_STEP_TYPES`**
   or an inbound event could fire a monetized ad break.
2. **`isFirstTimer` chat condition** — small. `chat.ts:118` computes it, `chat.ts:200` hands it to the
   dispatcher, `triggerDispatcher.ts:402`/`:414` drop it. Also expose `isFirstThisSession`; decide
   the op set (a boolean would get `contains`/`starts_with` today).
3. **Stream lifecycle `twitch_event` kinds** — medium. All four (`stream.online`/`offline`,
   `channel.update`, `ad_break.begin`) are subscribed and handled; none dispatches. Requires widening
   `AlertEventKind` + deciding what `TwitchEventSignal.actor` is for actorless events. Alert
   presentation is NOT coupled — it keys on `StreamEvent['kind']`.
4. **Phase E: `publish_event` step + `reward.state_changed`** — medium. Outbound is 3 hardcoded types
   from 7 fixed choke points while inbound is fully generic. `eventBus.ts:23` `publish()` is already
   generic. `REDIS_SAFE_STEP_TYPES` is an allowlist, so exclusion is automatic.
5. **Scheduled/timer trigger kind** — medium. All 9 kinds are reactive; `automaticAds.ts:143` and
   `windDownLoop.ts:284` are the precedents, and `claim()` needs only a tick-derived dedupe key.
   A partial workaround exists via external cron → inbound Redis.
6. **Counter overlay** — medium. `/overlay/status` already renders live counters, so this is
   per-counter positioning, not new capability. Needs a redacted payload — `emitCounters` broadcasts
   every key and label, which must not go on `OVERLAY_EVENTS`.
7. **Persisted publisher outbox / `XINFO GROUPS` lag readout / inbound stream trim / HMAC ingress** —
   deferred arc items. HMAC is an explicit conditional non-goal; escalate only if the threat model changes.

---

## Closed loops (stale claims, demonstrably done)

- **Media tests fail in worktrees (~21)** — fixed. `src/server/__fixtures__/media/` is tracked
  (7 files) and `testSetup.ts:16` pins `STREAMER_TOOLS_MEDIA_ROOT`. A fresh clone runs 1591/1591
  green with no `public/`.
- **`/settings` direct-navigation gap** — fixed and regression-tested (`routing.ts:88`, `routing.test.ts:48`).
- **`panels.tsx` split** (2026-07-23 roadmap WS1) — done; the file no longer exists.
- **Twitch layer untested** (WS2) — done; `twitch/api.test.ts` (1409 lines) + `auth.test.ts`
  (797 lines). `viewerRewards.ts` also picked up 386 test lines via Phase D.
- **`asHttpError` duplication** — was never plural; single definition since introduction.
  `src/server/http.ts` already *is* the shared error module. `isUniqueConstraintError` is already
  shared across 7 modules.
- **`canManage` re-derive on client-ID change** — already satisfied by construction; `fetchRewards`
  derives it fresh from two live Helix calls every time.
- **`tts_speak` uncapped on the inbound path** — fixed; `tts.ts:22`/`:253` slice to 500. Only
  `show_text` remains.
- **Counter delete orphans references** — refuted; `counters.ts:337-350` throws 409 with a full
  reference scan.
- **De-registering an app event loses its catalog silently** — refuted; the "N triggers reference
  this" hint, the `(unlisted)` option, and the inert badge all already ship, and the catalog is
  advisory and relearned.
- **`createTwitchReward`'s `audience` default is a security hole** — refuted; the default is
  documented and deliberate, there are exactly 2 call sites, and the app path passes it explicitly.
- **Retire the legacy migration tables** — ruled out by CLAUDE.md:317 (kept deliberately so a bad
  conversion is inspectable), and they are not dead: a fresh DB runs every migration body.
- **`categoryModules.ts` is a god-file** — refuted. It ranks 6th by size, is the only large server
  file with explicit section dividers, and has a 608-line test pinning its hardest invariants.
  Keep deferring.

---

## The one unanswered question

**Are registered apps mutually distrusting third parties, or all the operator's own scripts?**

Still the most decision-changing question, and it now has more riding on it than when it was first
asked. Narya holds exactly **one** Redis credential with no per-app ACLs, and `inboundKey(appId)` is
a pure function of the app id — so under "mutually distrusting," App A can XADD to App B's stream and
drive B's operator-authored triggers with chosen `{data.*}` today. The answer directly re-rates at
least five items:

| Item | If own scripts | If third parties |
|---|---|---|
| HMAC ingress / per-app Redis ACLs | non-goal | should-fix |
| `/api/ext/*` rate limiting | suggestion (your own for-loop, your own outage) | approaching blocking — one app can drain the operator's whole Helix budget |
| `show_text` uncapped render | hardening | should-fix (stream defacement by a third party) |
| Unbounded envelope `id` | hardening | should-fix |
| Poison-key cross-app wedge | availability bug | isolation failure |

Nothing else in this backlog changes what to build next as much as this does.
