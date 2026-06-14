# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
curl http://localhost:4317/api/goals
```

## Architecture

**Single-file backend** — `server/index.ts` owns everything: Express HTTP routes, WebSocket broadcast server (`/socket`), Twitch chat via `tmi.js`, OBS control via `obs-websocket-js`, `playerctl`-based music polling, and a Bun SQLite database.

**Modular frontend** — `src/main.tsx` is a thin router (pathname-based, no router library): `/overlay` → `OverlayPage`, `/tablet` → `TabletPage`, default → `DashboardPage`. Source layout:

```
src/
  types.ts              # domain types (Viewer, ChatEntry, StreamEvent, RunItem)
  services/
    dashboard.ts        # data service — Phase 2: returns stub data; Phase 3: real API calls
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
```

**Service / mock boundary** — `src/services/dashboard.ts` is the only file with stub data. Components and hooks always import domain types from `src/types.ts` and data from the service layer, never from a mock file directly. This keeps Phase 3 wiring to a service-layer swap.

**Real-time data flow** — the backend broadcasts WebSocket events (`chat:message`, `chat:moderated`, `goals:updated`, `music:updated`). The frontend's `useSocket` hook subscribes per event name and merges updates into local state seeded by initial REST fetches.

**Chat dual-layer storage** — `chat_events` is append-only (raw events). `chat_messages` is a mutable projection with soft-delete columns (`deleted_at`, `deleted_reason`, `moderation_event_id`). Dashboard shows moderated messages with a reason; overlay hides them entirely (the `compact` prop on `ChatPanel`).

**OBS connection** — lazy-connect via `ensureObs()`; reconnects automatically on `ConnectionClosed`. Scene switch and studio-mode transition are the only supported OBS calls.

**Music** — polled from `playerctl` at `MUSIC_POLL_INTERVAL_MS` (default 2000 ms). Only broadcasts when the fingerprint changes. Requires `playerctl` installed on the host desktop session; unavailable in Docker.

## Coding conventions

- TypeScript strict mode; no linter or formatter configured — match existing two-space indentation.
- Dashboard domain types (`Viewer`, `ChatEntry`, `StreamEvent`, `RunItem`) live in `src/types.ts`. Backend-wired types (`ChatMessage`, `MusicInfo`, etc.) stay in `src/legacy.tsx` alongside the hooks that use them.
- React components in PascalCase, hooks in `useCamelCase`, CSS classes in camelCase (`.chatPanel`, `.overlayFrame`).
- Overlay CSS must stay browser-source friendly: transparent background, fixed-position regions, no app chrome.
- Commits use short imperative hyphenated messages (`add-chat-event-history`).

## Configuration

`.env` (copy from `.env.example`):
```
TWITCH_CHANNEL=codeacula
OBS_WEBSOCKET_URL=ws://127.0.0.1:4455
OBS_WEBSOCKET_PASSWORD=
MUSIC_POLL_INTERVAL_MS=2000
```

Docker OBS URL uses `ws://host.docker.internal:4455`. `data/streamer-tools.sqlite` is private runtime data — never commit it.
