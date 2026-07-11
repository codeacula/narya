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

**Modular backend** — `src/server/index.ts` wires the Express HTTP routes and startup sequence. Backend modules own narrower responsibilities: `config.ts` for boot/infra-only env values (`PORT`, OAuth redirect URIs, static asset paths), `appConfig.ts` for the database-backed runtime config (Twitch/OBS/Discord/Chatterbox credentials, channel, music + quack settings) edited from Settings, `db.ts` for SQLite setup, `realtime.ts` for `/socket` broadcasts, `chat.ts` for Twitch chat ingestion and moderation persistence, `emotes.ts` for BTTV/7TV emote aggregation, `obs.ts` for OBS WebSocket calls and stats, `music.ts` for playerctl/manual now-playing state, `sounds.ts` for sound playback broadcasts, and `http.ts` for route helpers.

**Modular frontend** — `src/client/main.tsx` is a thin router (pathname-based, no router library): `/overlay` → `OverlayPage`, `/tablet` → `TabletPage`, default → `DashboardPage`. Source layout:

```
src/
  client/
    attention.ts        # useAttention hook: thank-worthy events + tagged chat, ack set, chime
    chat.tsx            # useChat hook + ChatPanel component
    clips.tsx           # useMediaQueue hook + ClipStage (redeem clip/sound playback)
    music.tsx           # useMusic hook + MusicPanel + MusicControls
    shoutouts.tsx       # useSessionShoutouts hook + ShoutoutTicker (overlay)
    sounds.ts           # useSoundEvents hook + quack sounds + playTone/playAttentionChime
    tts.ts              # useTtsEvents hook (plays TTS audio from WebSocket)
    realtime.ts         # shared WebSocket singleton + useSocket hook
    routing.ts          # dashboardRouteFromPath / pathForDashboardRoute
    main.tsx            # thin path-based router → page components
    services/
      dashboard.ts      # dashboard data service backed by REST endpoints
    ui/
      icons.tsx         # Icon component
      shell.tsx         # NavBar, StatBar, Panel, PopWindow, useDrag
      panels.tsx        # Chat, Spotlight, EventFeed, MODULES registry
      tweaks.tsx        # useTweaks (localStorage) + TweakSection/Radio/Toggle/Color controls
      notifications.tsx # ToastProvider + toast system
      serviceStatus.tsx # ServiceStatusToasts (settings:updated WebSocket events)
    pages/
      Dashboard.tsx         # cockpit dashboard (3 layouts, popout windows)
      SettingsPage.tsx      # Settings → Connections & credentials
      ViewerRewardsPage.tsx # Twitch viewer rewards management
      ViewerWindow.tsx      # popout viewer info window
      StreamInfoModal.tsx   # go-live stream info editor
      Overlay.tsx           # browser-source overlays (transparent): combined frame plus
                            # per-widget routes /overlay/{chat,nowplaying,sounds,shoutouts,clips}
      Tablet.tsx            # surface stream-deck controls
    styles/
      tokens.css        # design tokens (colors, type, spacing, motion)
      panel.css         # cockpit layout + component styles (kebab-case classes)
    styles.css          # overlay/tablet styles (camelCase classes)
  server/
    index.ts            # Express routes and server startup
    appConfig.ts        # database-backed runtime config store (GET/PUT /api/config)
    chat.ts             # Twitch chat via tmi.js, persistence, moderation events
    chatbotCommands.ts  # chatbot command dispatch
    chatters.ts         # chatter tracking routes
    config.ts           # boot/infra-only env config (PORT, OAuth URIs)
    db.ts               # SQLite connection and schema migrations
    discord.ts          # Discord status integration
    emotes.ts           # BTTV/7TV emote fetching and cache
    eventsub.ts         # Twitch EventSub WebSocket
    goLive.ts           # go-live stream info updates
    http.ts             # HTTP route errors and helpers
    llm.ts              # LLM (AI) routes
    media.ts            # scans public/clips + public/sounds; validates binding srcs
    music.ts            # playerctl/manual now-playing state
    obs.ts              # OBS WebSocket integration and dashboard stats
    realtime.ts         # Express app, HTTP server, WebSocket broadcasts
    rewardMedia.ts      # reward_media table: which clip/sound a redeem plays
    routes.ts           # core REST route registrations
    runtime.ts          # RuntimeState (Twitch auth token cache)
    sounds.ts           # sound playback events
    static.ts           # serves dist/ for production
    streamSession.ts    # stream session tracking
    tts.ts              # Chatterbox TTS integration
    viewerRewards.ts    # Twitch channel point reward management
    twitch/
      auth.ts           # Twitch OAuth flow
      api.ts            # Twitch API calls (stream info, ads, automod, etc.)
    types/
      tmi.d.ts          # local declarations for tmi.js
    dashboard/
      status.ts         # dashboard heartbeat and status aggregation
  shared/
    api.ts              # client/server API and WebSocket payload contracts
    constants.ts        # shared timing constants
    roles.ts            # Twitch role inference from badges
```

**Service boundary** — `src/client/services/dashboard.ts` is the dashboard's REST data boundary. Components and hooks import shared domain contracts from `src/shared/api.ts` and dashboard data from the service layer instead of calling `fetch` directly.

**Real-time data flow** — the backend broadcasts WebSocket events (`chat:message`, `chat:moderated`, `music:updated`, `sound:play`). The frontend's `useSocket` hook subscribes per event name and merges updates into local state seeded by initial REST fetches.

**Redeem media** — media files live in `public/clips` and `public/sounds` (Vite copies them into `dist/` on build; `public/clips/` is gitignored). `src/server/media.ts` scans those folders for `GET /api/media`; a reward's binding is stored in `reward_media` and **validated against that scan**, so a client can never bind a path outside `public/`. On redemption `eventsub.ts` calls `playRewardMedia()`, which broadcasts `media:play`; the `/overlay/clips` browser source queues and plays them one at a time. `POST /api/twitch/rewards/:id/media/play` triggers the same broadcast for testing. Never put media directly in `dist/` — `vite build` empties it.

**Stream-session scoping** — `stream_events.session_id` stamps each event with the active `stream_sessions` row at emit time (null when off-stream, and for rows predating the column). The dashboard dims events whose `sessionId` differs from `DashboardStatus.streamSessionId`, the attention feed ignores them, and `GET /api/dashboard/session-shoutouts` groups the current session's events per actor to drive the Shoutouts tab and the `/overlay/shoutouts` ticker.

**Chat dual-layer storage** — `chat_events` is append-only (raw events). `chat_messages` is a mutable projection with soft-delete columns (`deleted_at`, `deleted_reason`, `moderation_event_id`). Dashboard shows moderated messages with a reason; overlay hides them entirely (the `compact` prop on `ChatPanel`).

**OBS connection** — lazy-connects in `src/server/obs.ts`; reconnects automatically on `ConnectionClosed`. Scene switch and studio-mode transition are the only supported OBS calls.

**Music** — `src/server/music.ts` polls `playerctl` at `MUSIC_POLL_INTERVAL_MS` (default 2000 ms). Only broadcasts when the fingerprint changes. Requires `playerctl` installed on the host desktop session.

## Coding conventions

- TypeScript strict mode; no linter or formatter configured — match existing two-space indentation.
- Client/server API and WebSocket contracts live in `src/shared/api.ts`; import those instead of duplicating payload interfaces.
- When a shared API or WebSocket contract changes, trace every producer and consumer. Check REST initialization and subsequent WebSocket updates together; they must agree on payload shape, ordering, deduplication, and stale-state behavior.
- React components in PascalCase, hooks in `useCamelCase`, CSS classes in camelCase (`.chatPanel`, `.overlayFrame`).
- Overlay CSS must stay browser-source friendly: transparent background, fixed-position regions, no app chrome.
- Commits use semantic messages: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:` prefix, short imperative description (e.g. `feat: add chat command replies`).

## Configuration

Runtime config (Twitch/OBS/Discord/Chatterbox credentials, channel, OBS scenes, music + quack settings) lives in the database (`app_config` table) and is edited from **Settings → Connections & credentials**. Secrets are never returned to the client — `getAppConfig()` exposes `*Configured` booleans (the LLM `apiKeyConfigured` pattern). Saving via `PUT /api/config` reconnects only the affected services (`reconcileServices` in `index.ts`) and broadcasts `settings:updated`; no restart needed. The app boots gracefully with nothing configured.

`.env` is now minimal (copy from `.env.example`): only `PORT`, `TWITCH_REDIRECT_URI`, `DISCORD_REDIRECT_URI`, and `VITE_*` are read from the environment at runtime/build. The legacy credential vars are read **once on first boot** to seed `app_config` (see `seedFromEnv` in `appConfig.ts`), so existing setups migrate transparently; after that, edit values from the UI.

`data/streamer-tools.sqlite` is private runtime data — never commit it. Do not commit `.env` either; use `.env.example` for documented defaults.

## Commit and PR guidelines

Before handing work back, commit completed changes unless the user asks not to or the work is intentionally in progress.

Keep changes conceptually focused. Judge scope by architectural surface area rather than line count. If unrelated changes cross enough boundaries that correctness cannot be established confidently, split them along those boundaries. Avoid mixing unrelated UI, backend, and config changes in one commit.

Pull requests should include a short summary, the verification commands run, and screenshots for any visible dashboard/tablet/overlay changes. Call out any required `.env`, OBS, or Twitch setup changes.
