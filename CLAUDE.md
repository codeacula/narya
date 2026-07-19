# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Verification

After code changes, run the relevant automated checks. Use `bun run typecheck` and `bun run build` as the baseline, run `bun test` when the affected behavior has test coverage, smoke-test relevant endpoints after backend changes, and perform visible Chromium/CDP validation for frontend behavior. Report any checks that were not run or could not be completed.

For dev servers, confirm the target port is free first (e.g. `lsof -i :PORT`) and stop stale project processes before restarting.

## Workflow

For non-trivial features, write a short plan before implementation. Request confirmation only when the available choices materially change behavior, architecture, security, or scope.

Superpowers skills write specs and plans under `docs/superpowers/`, and committing them is fine — no need to relocate them to `.claude/plans/`.

## Code review

When asked to review code, review the code that exists rather than implementing changes unless explicitly requested.

Determine the review mode first:

- **Diff mode** — review the staged diff, working-tree diff, commit, branch, or PR requested by the user. If changes are staged, inspect `git diff --cached`.
- **Codebase mode** — audit the requested repository, module, or directory by architectural blast radius rather than crawling every file equally.

Before reviewing a diff:

- Identify the intended behavior and conceptual scope.
- Set aside generated files, lockfiles, and formatting-only churn.
- Request a split when unrelated concerns make the change unsafe to reason about.
- Trace changed contracts through their producers and consumers. Do not limit review to changed lines when correctness depends on nearby code.
- Verify architectural claims against the current repository; do not assume this document is current.

Review in this order:

1. Correctness and data integrity
2. Security, authentication, authorization, and secret handling
3. Client/server and persistence boundaries
4. Failure behavior and operability
5. Maintainability and readability
6. Performance
7. Style

Every finding must identify a concrete failure mode and cite a file and location. Distinguish observed defects from inferred risks and preferences. Do not report speculative issues as defects.

Use exactly one severity per comment:

- **Blocking** — merge risks data integrity, security, or a durable contract.
- **Should fix** — a demonstrated defect or meaningful architectural erosion.
- **Suggestion** — an optional improvement or preference.
- **Question** — intent cannot be established from available evidence.

Cap suggestions at approximately five. Prioritize material findings over volume. If no material defects are found, say so directly rather than inventing comments.

For substantial changes, ask:

- What invariant or user-visible behavior is being protected?
- What happens on duplicate delivery, repeated rendering, or retry?
- What happens when the operation fails halfway through?
- What happens under concurrent execution?
- Are existing SQLite data and stored configuration still readable?
- Are REST and WebSocket payload changes compatible with every producer and consumer?
- Can stale asynchronous work overwrite newer state?
- Is authentication and authorization enforced at the backend boundary?
- Could secrets, tokens, chat content, or moderated content be exposed?
- How will a production failure be detected?
- Is the complexity proportional to the requirement?

For a diff review, use this output:

1. A verdict: Approve, Approve with changes, Request changes, Request split, or Unable to determine, followed by one sentence explaining why.
2. Findings grouped by severity, highest first.
3. A verification note stating what was and was not inspected or executed.
4. The one or two most important unanswered questions, when applicable.

For a codebase review, replace the verdict with a concise health summary, report systemic patterns with representative locations and rough instance counts, and order remediation by blast radius.

A review request does not authorize editing, committing, or pushing. If the user asks to fix findings, target the reported defects directly and validate the specific failure paths.

## Preferences

Prefer the simplest approach that preserves the required security and runtime behavior. Do not bypass established OAuth, authorization, secret-storage, or runtime-configuration boundaries merely to reduce implementation size. Ask before introducing materially heavier infrastructure that is not required by the existing architecture.

## Editing

Preserve file encoding and Unicode characters when editing. Inspect the resulting diff for unintended substitutions or normalization changes.

## Stack

Bun-powered Vite + React + TypeScript SPA with an Express/Bun backend. Validation is via typecheck, the `bun test` suite (`*.test.ts` colocated with source), and build.

A C#/.NET + Vue rewrite was attempted and abandoned on 2026-07-19. It is archived in the git tag `archive/csharp-vue-rewrite`; this stack is the only one that ships.

## Commands

```sh
bun install
bun run dev          # backend on :4317, Vite on :5173
bun run typecheck    # tsc --noEmit
bun test             # bun test suite (*.test.ts); uses an in-memory DB under NODE_ENV=test
bun run build        # typecheck + Vite production build → dist/
```

Set `STREAMER_TOOLS_DB=/path/to/scratch.sqlite` to point the backend at a throwaway database — useful for exercising the app end-to-end without touching the operator's `data/streamer-tools.sqlite`.

Smoke-test backend endpoints after backend changes:
```sh
curl http://localhost:4317/api/health
curl http://localhost:4317/api/chat/recent
curl http://localhost:4317/api/music/current
```

## Architecture

The following is a navigation aid, not a substitute for inspecting the current repository. Verify paths, ownership, contracts, and runtime behavior before relying on these descriptions during review.

**Modular backend** — `src/server/index.ts` wires the Express HTTP routes and startup sequence. Backend modules own narrower responsibilities: `config.ts` for boot/infra-only env values (`PORT`, `HOST`, `DASHBOARD_TOKEN`, OAuth redirect URIs), `appConfig.ts` for the database-backed runtime config (Twitch/OBS/Discord/Chatterbox credentials, channel, OBS scene prefix, music + sound volume) edited from Settings, `db.ts` for SQLite setup, `realtime.ts` for `/socket` broadcasts, `chat.ts` for Twitch chat ingestion and moderation persistence, `emotes.ts` for BTTV/7TV emote aggregation, `obs.ts` for OBS WebSocket calls and stats, `music.ts` for playerctl/manual now-playing state, `sounds.ts` for sound playback broadcasts, and `http.ts` for route helpers.

**Modular frontend** — `src/client/main.tsx` is a thin router (pathname-based, no router library): `/overlay` → `OverlayPage`, `/tablet` → `TabletPage`, default → `DashboardPage`. Source layout:

```
src/
  client/
    attention.ts        # useAttention hook: thank-worthy events + tagged chat, ack set, chime
    auth.ts             # dashboard token capture/storage, withToken(), rejection signalling
    automod.tsx         # useAutomodQueue hook + AutomodPanel + AutomodQuickActions
    chat.tsx            # useChat hook + ChatPanel component
    chatText.ts         # isMentionOf + URL link tokenizing for chat text
    clips.tsx           # useMediaQueue hook + ClipStage (redeem clip/sound playback)
    errors.ts           # errorMessage(caught, fallback) — shared catch-to-string helper
    eventKinds.ts       # event-kind verb/chip/tone presentation + attention kind set
    mediaMute.ts        # useMediaMute hook (master sound/video mute switch)
    music.tsx           # useMusic hook + MusicPanel + MusicControls
    overlayPlaceholders.tsx # useOverlayPlaceholders hook + OverlayPlaceholder outline
    overlayText.tsx     # overlay text queue helpers + useOverlayTextQueue + OverlayTextStage
    quickActions.tsx    # useQuickActions hook + QuickActionsPanel + TabletQuickActions
    scenes.ts           # switchableScenes / sceneLabel (OBS scene prefix filtering + ordering)
    shoutouts.tsx       # useSessionShoutouts hook + ShoutoutTicker (overlay)
    sounds.ts           # useSoundEvents hook + preloaded quack sources + playTone/playAttentionChime
    storage.ts          # loadStoredJson / saveStoredJson (localStorage that never throws)
    streamStatus.ts     # useStreamStatus hook (REST seed + status:updated)
    suggestions.ts      # useDebouncedSuggestions type-ahead + formatBoxArtUrl
    tabletChat.tsx      # TabletChatPanel (tablet-chrome chat surface)
    tts.ts              # useTtsEvents hook (plays TTS audio from WebSocket)
    realtime.ts         # shared WebSocket singleton + useSocket hook
    routing.ts          # dashboardRouteFromPath / pathForDashboardRoute / overlayFromPath
    main.tsx            # thin path-based router → page components
    services/
      dashboard.ts      # dashboard data service backed by REST endpoints
    ui/
      authGate.tsx      # AuthGate: token-rejection screen in front of operator pages
      icons.tsx         # Icon component
      shell.tsx         # NavBar, StatBar, Panel, PopWindow, useDrag
      panels.tsx        # Chat, Spotlight, EventFeed, MODULES registry
      tweaks.tsx        # useTweaks (localStorage) + TweakSection/Radio/Toggle/Color controls
      notifications.tsx # ToastProvider + toast system
      serviceStatus.tsx # ServiceStatusToasts (settings:updated WebSocket events)
    pages/
      Dashboard.tsx         # cockpit dashboard (3 layouts, popout windows)
      SettingsPage.tsx      # ConnectionsSettingsPage — Twitch sign-in + the Connections section
      StreamCategoriesPage.tsx # saved stream categories and their tags
      ViewerRewardsPage.tsx # Twitch viewer rewards management
      ViewersPage.tsx       # viewer roster (all/live/VIPs/mods) + ViewerOrb/RoleBadges
      ViewerDetailPage.tsx  # ViewerDetailPane: one viewer's details, messages, role actions
      ViewerWindow.tsx      # popout viewer info window
      StreamInfoModal.tsx   # go-live stream info editor
      Overlay.tsx           # browser-source overlays (transparent): combined frame plus
                            # per-widget routes
                            # /overlay/{chat,nowplaying,sounds,shoutouts,clips,status,text}
      Tablet.tsx            # surface stream-deck controls
      settings/
        SettingsShell.tsx     # settings shell: section rail + body selection by id
        sections.ts           # the settings section/group registry (single declaration site)
        shared.tsx            # SettingsHeader / SettingsRow layout primitives
        ConnectionsSection.tsx # credentials + channel form (Twitch/OBS/Discord)
        ContentSection.tsx    # media asset catalog + sound/clip button management
        GoLiveSection.tsx     # go-live settings (Discord guild/channel, OBS)
        LlmSection.tsx        # LLM provider settings + connection test
        TtsSection.tsx        # Chatterbox TTS settings, voices, and test speak
        ActionsPage.tsx       # Action editor (ordered steps)
        AutomationPage.tsx    # automation trigger editor
        ModulesPage.tsx       # category module editor
        automation.ts         # React-free step/trigger limits, validation, run-result formatting
    styles/
      tokens.css        # design tokens (colors, type, spacing, motion)
      panel.css         # cockpit layout + component styles
    styles.css          # overlay/tablet styles
  server/
    index.ts            # Express routes and server startup
    appConfig.ts        # database-backed runtime config store (GET/PUT /api/config)
    auth.ts             # dashboard/overlay token roles, OVERLAY_EVENTS allowlist, route guards
    automaticAds.ts     # ad-schedule loop + the pure evaluateAdSchedule decision
    automod.ts          # AutoMod held-message queue (record/resolve/sweep)
    chat.ts             # Twitch chat via tmi.js, persistence, moderation events
    actions.ts          # Action repository + routes (reusable multi-step actions)
    actionExecutor.ts   # runs an Action's steps; media resolution is an injected port
    actionTemplates.ts  # {actor} {input} {arg1} {rest} … template renderer
    automation.ts       # composition root: executor + trigger dispatcher
    automationTriggers.ts # trigger repository, routes, seeded slash commands
    categoryModules.ts  # category modules + the reward-group switch coordinator
    clips.ts            # clip buttons over the shared labeled-button repo
    rewardMedia.ts      # the media:play broadcast (reward bindings are Actions now)
    labeledButtons.ts   # createLabeledButtonRepo: shared (id, label, filename) CRUD + trigger
    legacyMigration.ts  # one-shot conversions into the automation schema (runOnce)
    mediaAssets.ts      # configured media catalog (media_assets)
    mediaMute.ts        # persisted master sound/video mute switch + routes
    triggerDispatcher.ts # matching, cooldowns, dedup, bot-loop prevention
    chatters.ts         # chatter tracking routes
    config.ts           # boot/infra-only env config (PORT, OAuth URIs)
    db.ts               # SQLite connection and schema migrations
    discord.ts          # Discord status integration
    emotes.ts           # BTTV/7TV emote fetching and cache
    eventsub.ts         # Twitch EventSub WebSocket
    goLive.ts           # go-live stream info updates
    http.ts             # HTTP route errors, helpers, and the handle() route wrapper
    llm.ts              # LLM (AI) routes
    media.ts            # scans public/clips + public/sounds; validates binding srcs
    music.ts            # playerctl/manual now-playing state
    numeric.ts          # clamp / clampFinite arithmetic helpers
    obs.ts              # OBS WebSocket integration and dashboard stats
    overlayPlaceholders.ts # in-memory overlay bounds flag + routes
    realtime.ts         # Express app, HTTP server, WebSocket broadcasts
    routes.ts           # core REST route registrations
    runtime.ts          # RuntimeState (Twitch auth token cache)
    sounds.ts           # sound buttons + playback events (labeled-button repo)
    static.ts           # serves dist/ for production
    streamCategories.ts # saved stream categories, their tags, and routes
    streamSession.ts    # stream session tracking
    streamStatus.ts     # persisted stream status line + routes
    tags.ts             # tag normalization, tag history, suggestion merging
    tts.ts              # Chatterbox TTS integration
    twitchIdentity.ts   # which Twitch account the stored OAuth tokens belong to
    viewerRewards.ts    # Twitch channel point reward management
    viewers.ts          # VIP/moderator roster and grant/revoke routes
    twitch/
      auth.ts           # Twitch OAuth flow
      api.ts            # Twitch API calls (stream info, ads, automod, etc.) + twitchFetch
    types/
      tmi.d.ts          # local declarations for tmi.js
    dashboard/
      status.ts         # dashboard heartbeat and status aggregation
  shared/
    api.ts              # client/server API and WebSocket payload contracts
    constants.ts        # shared timing constants
    roles.ts            # Twitch role inference from badges
    time.ts             # formatAgo relative-time formatting
    tts.ts              # TTS tone presets
```

**Service boundary** — `src/client/services/dashboard.ts` is the dashboard's REST data boundary. Components and hooks import shared domain contracts from `src/shared/api.ts` and dashboard data from the service layer instead of calling `fetch` directly.

**Real-time data flow** — the backend broadcasts WebSocket events (`chat:message`, `chat:moderated`, `music:updated`, `sound:play`, `overlay:text`, `category-modules:updated`). The frontend's `useSocket` hook subscribes per event name and merges updates into local state seeded by initial REST fetches. `OVERLAY_EVENTS` in `auth.ts` is the allowlist of events an unauthenticated overlay browser source may receive — a new overlay event must be added there or it never arrives, and anything carrying operator configuration must stay off it.

**Automation platform** — three layers, deliberately separable, contracts in `src/shared/api.ts`:

- `media_assets` (`mediaAssets.ts`) — the configured catalog. Rewards, Actions, and commands reference **asset IDs**; raw filesystem entries appear only in the Content settings picker. `resolveMediaAssetForPlayback()` is the single choke point that stops a disabled, missing, or unconfigured asset from reaching an overlay.
- `actions` + `action_steps` (`actions.ts`, `actionExecutor.ts`) — named, reusable, ordered steps. **`delayMs` is relative to the start of the invocation, not the previous step**, so steps sharing a delay start together rather than queueing behind each other's playback. A failing step never aborts the others; the run rolls up to `succeeded`/`partial`/`failed`/`skipped`, and a `skipped` run broadcasts nothing. Pending delays are never replayed after a restart.
- `automation_triggers` (`automationTriggers.ts`, `triggerDispatcher.ts`) — typed sources: reward, Twitch event, chat phrase, viewer `!command`, dashboard `/command`, manual, module lifecycle. A trigger with no `moduleId` is global; a module-scoped one fires only while its module is active. Deduplication keys off the source event ID in `automation_runs` (partial unique index) so a redelivery cannot fire an Action twice.

`automation.ts` is the composition root — `eventsub.ts` and `chat.ts` both need the executor and dispatcher, and neither can import `index.ts` (where `RuntimeState` is built) without a cycle.

**Slash commands are server-owned.** Anything the operator types starting with `/` goes to `POST /api/automation/slash` and is executed or **rejected there**. It is never forwarded to Twitch. The client must not parse them: the parser this replaced fell through to `sendChatMessage` on an unknown command, so a typo was published to chat.

**Category modules** (`categoryModules.ts`) — a module owns Twitch categories and reward groups; switching game deactivates one and activates another. `category_module_games.game_id` is the **primary key**, which is what enforces "a category belongs to at most one module" in the database rather than in application code. The coordinator is fed by Narya's own stream-info update, EventSub `channel.update`, `stream.online`, every EventSub reconnect, and a manual reconcile — transitions are serialized by a generation number so a rapid A→B→C cannot let a stale transition land last. **A failed category lookup is not a null category**: null means "authoritatively no category" and stands every module down, while a lookup failure calls `onCategoryLookupFailed` and changes no remote reward state. A reward group with no module owner is never touched by switching.

**Redeem media and alerts are Actions.** There is no reward→file table and no alert settings table read at runtime any more. A redeem plays media because a `reward` trigger fires an Action with a `play_media` step; a sub alert shows text because a `twitch_event` trigger fires an Action with `show_text` + `play_media`. The legacy `reward_media`, `tts_reward_enabled`, and `alert_settings` tables still exist but are only read by `legacyMigration.ts`. **If you add a second path that plays a redeem, you will double-play it** — `src/server/redeemOnce.test.ts` exists to catch exactly that.

**Chat commands are Actions too — do not hard-code one.** `!quack` used to be a branch in `chat.ts` that picked a random file from a constant array; it is now an Action with a single `play_media` step in `random` selection, fired by a `viewer_command` trigger (`migrateQuackCommandIntoAction`). Randomness is a property of the step — `PlayMediaPayload` is `{ assetIds: string[], selection: 'first' | 'random' }` — so "play a random one of these" never needs new code. `!tts` is the only built-in chat branch left. Adding another hard-coded command both bypasses cooldowns, roles, and dedup, and leaves the operator unable to see or edit it.

**Overlay sources** — `/overlay/clips` receives `media:play` and drains **audio and video as independent lanes**: only video is visually exclusive, so an alert sound never waits out a clip. `/overlay/text` receives `overlay:text` (Action `show_text` steps, including migrated alert banners, which carry an optional `tone` for their accent colour). Media files live in `public/clips` and `public/sounds` (Vite copies them into `dist/` on build; `public/clips/` is gitignored). Never put media directly in `dist/` — `vite build` empties it.

**An overlay URL is in someone's OBS scene collection — you cannot just delete it.** Overlay paths are resolved by `overlayFromPath` in `routing.ts`, and *everything* under `/overlay` resolves there: an unrecognized path returns `'unknown'` and renders an inert transparent notice. It must never fall through to the dashboard, which is exactly what the retired `/overlay/alerts` did — an OBS browser source rendered the operator's chat, controls, and viewer data into a live scene. `/overlay/alerts` is therefore **aliased to the text overlay**, not deleted, so the existing source keeps showing alert banners. It maps to text *only*: the alert's sound and clip are a `play_media` step and `/overlay/clips` is already a source in the same scene receiving `media:play`, so rendering media on both would **play every alert twice**. Retiring an overlay route means aliasing it and covering it in `routing.test.ts`.

**Overlay bounds** (`overlayPlaceholders.ts`) — most overlays are invisible until an event fires, so they cannot be positioned in OBS. The dashboard's Controls panel toggles `overlay:placeholders`, and every source draws a labelled outline of its own bounds; real content still renders on top. `OverlayPlaceholder` is attached **once, in `main.tsx`'s overlay branch**, not per page, so a new overlay cannot ship without one. The flag is **in memory and never persisted**: boxes drawn over a live stream are the bad state, so a restart must clear it rather than restore it, and `setOverlayPlaceholders` only accepts a literal `true`. The GET is on the overlay token's read allowlist so a source can seed itself; the PUT is operator-only (the token is GET-only), so a browser source cannot switch the boxes on for every other source.

**Stream-session scoping** — `stream_events.session_id` stamps each event with the active `stream_sessions` row at emit time (null when off-stream, and for rows predating the column). The dashboard dims events whose `sessionId` differs from `DashboardStatus.streamSessionId`, the attention feed ignores them, and `GET /api/dashboard/session-shoutouts` groups the current session's events per actor to drive the Shoutouts tab and the `/overlay/shoutouts` ticker.

**Migrations** — the schema statements in `db.ts` are idempotent by construction (`create table if not exists`, the allowlisted `addColumnIfMissing`) and re-run every boot. **Data** migrations are not: deriving rows from other rows would duplicate them on every restart. Anything that writes rows computed from other rows goes through `runOnce(id, fn)` in `db.ts`, which shares a transaction with the ledger write. Legacy tables are left intact after migrating so a bad conversion is inspectable rather than unrecoverable.

When verifying a migration against real data, snapshot with `VACUUM INTO`, not `cp`. The database runs in WAL mode, so a plain file copy silently omits recent writes and will make a correct migration look like it is dropping rows.

**Never verify against the real database from an ad-hoc script.** `db.ts` resolves its path at import time, and ES imports are hoisted — a script that sets `NODE_ENV`/`STREAMER_TOOLS_DB` in its body has *already* opened `data/streamer-tools.sqlite` by the time that line runs, and any write lands in the operator's live data. Put the check in a `*.test.ts` file (`bun test` sets `NODE_ENV=test` before anything imports, so the DB is in-memory), or pass the override in the environment of the command itself.

**Chat dual-layer storage** — `chat_events` is append-only (raw events). `chat_messages` is a mutable projection with soft-delete columns (`deleted_at`, `deleted_reason`, `moderation_event_id`). Dashboard shows moderated messages with a reason; overlay hides them entirely (the `compact` prop on `ChatPanel`).

**OBS connection** — lazy-connects in `src/server/obs.ts`; reconnects automatically on `ConnectionClosed`. Scene switch and studio-mode transition are the only supported OBS calls.

**Music** — `src/server/music.ts` polls `playerctl` at `MUSIC_POLL_INTERVAL_MS` (default 2000 ms). Only broadcasts when the fingerprint changes. Requires `playerctl` installed on the host desktop session.

## Coding conventions

- TypeScript strict mode; no linter or formatter configured — match existing two-space indentation.
- Client/server API and WebSocket contracts live in `src/shared/api.ts`; import those instead of duplicating payload interfaces.
- When a shared API or WebSocket contract changes, trace every producer and consumer. Check REST initialization and subsequent WebSocket updates together; they must agree on payload shape, ordering, deduplication, and stale-state behavior.
- React components in PascalCase, hooks in `useCamelCase`, CSS classes in kebab-case (`.chat-panel`, `.overlay-frame`).
- Overlay CSS must stay browser-source friendly: transparent background, fixed-position regions, no app chrome.
- Commits use semantic messages: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:` prefix, short imperative description (e.g. `feat: add chat command replies`).

## Configuration

Runtime config (Twitch/OBS/Discord/Chatterbox credentials, channel, OBS scene prefix, music + sound volume) lives in the database (`app_config` table) and is edited from **Settings → Connections & credentials**. Secrets are never returned to the client — `getAppConfig()` exposes `*Configured` booleans (the LLM `apiKeyConfigured` pattern). Saving via `PUT /api/config` reconnects only the affected services (`reconcileServices` in `index.ts`) and broadcasts `settings:updated`; no restart needed. The app boots gracefully with nothing configured.

**`.env` seeds nothing.** Only `PORT`, `HOST`, `DASHBOARD_TOKEN`, the two OAuth redirect URIs, and `VITE_*` are read from the environment, and all of them are read on *every* boot. There is no `seedFromEnv`: `TWITCH_CLIENT_ID`, `OBS_SCENES`, `QUACK_VOLUME` and friends used to populate `app_config` once on first boot and then be ignored forever, which made `.env` read like live configuration when it was not. Defaults for a fresh install are code literals (`DEFAULTS` in `appConfig.ts`). **Do not reintroduce an env read for anything the Settings UI owns.**

The OAuth redirect URIs stay in the environment because they cannot be derived — they must match the Twitch/Discord app registration exactly — but they have working defaults, so `.env` need not set them.

**OBS owns the scene list.** `app_config.obs_scene_prefix` (default `Scene - `) decides which of OBS's scenes become switch buttons and is stripped from the label; it rides on `ObsStatus.scenePrefix` so the dashboard and tablet get it without a second fetch. An empty prefix means "every scene". There is deliberately no configured scene list to fall back on when OBS is down — the old `obs_scenes` column was a hand-maintained copy that went stale the moment a scene was renamed, and `switchObsScene` would then reject the button it had just offered. A prefix change is its own `AppConfigChange` (`obsScenePrefix`) that re-broadcasts `obs:status` rather than reconnecting OBS, so a display tweak cannot drop a live session.

**Twitch auth is OAuth-only.** The `TWITCH_USER_TOKEN` / `TWITCH_BOT_USER_TOKEN` env fallbacks are gone: a pasted token has no refresh token and no expiry, so it rotted silently while `authSource` still reported it as authenticated.

`data/streamer-tools.sqlite` is private runtime data — never commit it. Do not commit `.env` either; use `.env.example` for documented defaults.

## Commit and PR guidelines

Before handing work back, commit completed changes unless the user asks not to or the work is intentionally in progress.

Keep changes conceptually focused. Judge scope by architectural surface area rather than line count. If unrelated changes cross enough boundaries that correctness cannot be established confidently, split them along those boundaries. Avoid mixing unrelated UI, backend, and config changes in one commit.

Pull requests should include a short summary, the verification commands run, and screenshots for any visible dashboard/tablet/overlay changes. Call out any required `.env`, OBS, or Twitch setup changes.
