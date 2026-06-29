# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Verification

After any code change, run typecheck/build and verify in-browser before declaring done. For dev servers, confirm the target port is free first (e.g. `lsof -i :PORT`) and kill stale processes before restarting.

## Workflow

For any non-trivial feature, write a short plan first and confirm the approach before implementing across multiple files.

## Preferences

Prefer the simplest approach that meets the requirement. Avoid building full OAuth flows, token storage, or elaborate UI when simple env-based credentials suffice; ask before adding heavy infrastructure.

## Editing

When editing files with multi-byte/Unicode characters (powerline glyphs, emoji), expect the Edit tool to fail and fall back to a Python or sed-based replacement rather than retrying Edit repeatedly.

## Stack

Bun-powered Vite + React + TypeScript SPA with an Express/Bun backend. No test suite; validation is via typecheck and build.

## Commands

```sh
bun install
bun run dev          # backend on :4317, Vite on :5173
bun run typecheck    # tsc --noEmit
bun run build        # typecheck + Vite production build → dist/
docker compose up --build  # containerized run with ./data mounted for SQLite
```

Smoke-test backend endpoints after backend changes:
```sh
curl http://localhost:4317/api/health
curl http://localhost:4317/api/chat/recent
curl http://localhost:4317/api/music/current
```

## Architecture

**Modular backend** — `src/server/index.ts` wires the Express HTTP routes and startup sequence. Backend modules own narrower responsibilities: `config.ts` for boot/infra-only env values (`PORT`, OAuth redirect URIs, static asset paths), `appConfig.ts` for the database-backed runtime config (Twitch/OBS/Discord/ElevenLabs credentials, channel, music + quack settings) edited from Settings, `db.ts` for SQLite setup, `realtime.ts` for `/socket` broadcasts, `chat.ts` for Twitch chat ingestion and moderation persistence, `emotes.ts` for BTTV/7TV emote aggregation, `obs.ts` for OBS WebSocket calls and stats, `music.ts` for playerctl/manual now-playing state, `sounds.ts` for sound playback broadcasts, and `http.ts` for route helpers.

**Modular frontend** — `src/client/main.tsx` is a thin router (pathname-based, no router library): `/overlay` → `OverlayPage`, `/tablet` → `TabletPage`, default → `DashboardPage`. Source layout:

```
src/
  client/
    services/
      dashboard.ts        # dashboard data service backed by REST endpoints
    legacy.tsx            # backend-wired hooks + overlay/tablet components (ChatPanel, MusicPanel, etc.)
    ui/
      icons.tsx           # Icon component
      shell.tsx           # NavBar, StatBar, Panel, PopWindow, useDrag
      panels.tsx          # Chat, Spotlight, EventFeed, RunSheet, MODULES registry
      tweaks.tsx          # useTweaks (localStorage) + TweakSection/Radio/Toggle/Color controls
    pages/
      Dashboard.tsx       # cockpit dashboard (3 layouts, popout windows, settings page)
      Overlay.tsx         # browser-source overlay (transparent, chat + now-playing)
      Tablet.tsx          # surface stream-deck controls
    styles/
      tokens.css          # design tokens (colors, type, spacing, motion)
      panel.css           # cockpit layout + component styles (kebab-case classes)
    styles.css            # legacy overlay/tablet styles (camelCase classes)
  server/
    index.ts           # Express routes and server startup
    chat.ts            # Twitch chat via tmi.js, persistence, moderation events
    config.ts          # environment-backed runtime config
    db.ts              # SQLite connection and schema migrations
    emotes.ts          # BTTV/7TV emote fetching and cache
    http.ts            # HTTP route errors and helpers
    music.ts           # playerctl/manual now-playing state
    obs.ts             # OBS WebSocket integration and dashboard stats
    realtime.ts        # Express app, HTTP server, WebSocket broadcasts
    sounds.ts          # sound playback events
    types/
      tmi.d.ts         # local declarations for tmi.js
  shared/
    api.ts             # client/server API and WebSocket payload contracts
```

**Service boundary** — `src/client/services/dashboard.ts` is the dashboard's REST data boundary. Components and hooks import shared domain contracts from `src/shared/api.ts` and dashboard data from the service layer instead of calling `fetch` directly.

**Real-time data flow** — the backend broadcasts WebSocket events (`chat:message`, `chat:moderated`, `music:updated`, `sound:play`). The frontend's `useSocket` hook subscribes per event name and merges updates into local state seeded by initial REST fetches.

**Chat dual-layer storage** — `chat_events` is append-only (raw events). `chat_messages` is a mutable projection with soft-delete columns (`deleted_at`, `deleted_reason`, `moderation_event_id`). Dashboard shows moderated messages with a reason; overlay hides them entirely (the `compact` prop on `ChatPanel`).

**OBS connection** — lazy-connects in `src/server/obs.ts`; reconnects automatically on `ConnectionClosed`. Scene switch and studio-mode transition are the only supported OBS calls.

**Music** — `src/server/music.ts` polls `playerctl` at `MUSIC_POLL_INTERVAL_MS` (default 2000 ms). Only broadcasts when the fingerprint changes. Requires `playerctl` installed on the host desktop session; unavailable in Docker.

## Coding conventions

- TypeScript strict mode; no linter or formatter configured — match existing two-space indentation.
- Client/server API and WebSocket contracts live in `src/shared/api.ts`; import those instead of duplicating payload interfaces.
- React components in PascalCase, hooks in `useCamelCase`, CSS classes in camelCase (`.chatPanel`, `.overlayFrame`).
- Overlay CSS must stay browser-source friendly: transparent background, fixed-position regions, no app chrome.
- Commits use short imperative hyphenated messages (`add-chat-event-history`).

## Configuration

Runtime config (Twitch/OBS/Discord/ElevenLabs credentials, channel, OBS scenes, music + quack settings) lives in the database (`app_config` table) and is edited from **Settings → Connections & credentials**. Secrets are never returned to the client — `getAppConfig()` exposes `*Configured` booleans (the LLM `apiKeyConfigured` pattern). Saving via `PUT /api/config` reconnects only the affected services (`reconcileServices` in `index.ts`) and broadcasts `settings:updated`; no restart needed. The app boots gracefully with nothing configured.

`.env` is now minimal (copy from `.env.example`): only `PORT`, `TWITCH_REDIRECT_URI`, `DISCORD_REDIRECT_URI`, and `VITE_*` are read from the environment at runtime/build. The legacy credential vars are read **once on first boot** to seed `app_config` (see `seedFromEnv` in `appConfig.ts`), so existing setups migrate transparently; after that, edit values from the UI.

Docker OBS URL uses `ws://host.docker.internal:4455`. `data/streamer-tools.sqlite` is private runtime data — never commit it.
