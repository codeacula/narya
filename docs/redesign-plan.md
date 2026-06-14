# Streamer Tools — Frontend Redesign Plan

Source of truth for porting the "cockpit" design into the real project. Written for
an implementer (Sonnet) picking this up mid-session or fresh.

## Goal & phases

We are replacing the current frontend UI with the "cockpit" design example.

- **Phase 1 — DONE.** Got the design example running for review (static-served from
  `/home/codeacula/Downloads/` at `http://127.0.0.1:8088/Streamer%20Control%20Panel.html`).
- **Phase 2 — THIS PLAN.** Build a *clickable mock* (fake data, no backend) of the
  redesigned UI in the real repo, so we can validate the workflow feels natural.
  **Start with the Dashboard only**, review/iterate on theme + interactions, then do
  Tablet and Overlay.
- **Phase 3 — LATER.** Wire the mock to the real Express/WS backend.

### Phase 2 ground rules
- **No backend calls.** No `fetch`, no WebSocket. Every control updates local React
  state seeded from `src/mock/`. Goal is to feel the workflow.
- Funnel all data access through `src/mock/` so Phase 3 is a data-source swap, not a
  rewrite. Keep component props shaped like real domain data.
- Validate with `bun run typecheck` and `bun run build` as you go. There is no test
  suite. TypeScript strict mode is on.

## Source material (read these — all exist on disk)

- `/home/codeacula/Downloads/streamer/app.jsx` — assembles the cockpit: layouts
  (`cockpit`/`mission`/`modular`), pop-out windows, accent-var effect, Settings page.
- `/home/codeacula/Downloads/streamer/shell.jsx` — `Icon`, `useDrag`, `NavBar`,
  `StatBar`/`Gauge`, `Panel`, `PopWindow`.
- `/home/codeacula/Downloads/streamer/panels.jsx` — `Chat`, `ChatInput`, `Spotlight`,
  `EventFeed`, `RunSheet`, the `MODULES` registry, `badgesFor`, `ROLE_BADGE`, `EVT_ICON`.
- `/home/codeacula/Downloads/streamer/tweaks-panel.jsx` — `useTweaks` + `Tweak*`
  controls. **NOTE:** this is a design-tool harness. Strip the host protocol
  (`postMessage`, `__edit_mode_*`, `__activate_edit_mode`, EDITMODE blocks). Keep
  `useTweaks` as plain local state (persist to `localStorage`), and keep the visual
  `Tweak*` controls (`TweakSection`, `TweakRadio`, `TweakToggle`, `TweakColor`,
  `TweakSelect`, `TweakSlider`). The floating drawer should be toggled by an in-app
  button, not by host activation.
- `/home/codeacula/Downloads/streamer/data.js` — mock data (IIFE on `window.CP_DATA`).
- `/home/codeacula/Downloads/colors_and_type.css` — design tokens (`--gold-500`,
  `--bg-1`, `--fg-1`, `--font-body`, `--space-*`, `--border-*`, etc.). `panel.css`
  depends on these.
- `/home/codeacula/Downloads/streamer/panel.css` — cockpit layout + component styles
  (kebab-case classes: `.panel-head`, `.gauge-value`, `.stage--cockpit`, etc.).

## Current project state (what you're changing)

- `src/main.tsx` (~491 lines, single file): `ChatMessage`/`Role`/`MusicInfo` types,
  hooks (`useSocket`, `useChat`, `useMusic`, `useEmotes`, `useSoundEvents`), components
  (`ChatPanel`, `MusicPanel`, `OverlayPage`, `MusicControls`, `ControlSurface`,
  `DashboardPage`, `TabletPage`), and a pathname router in `App`. All wired to the
  real backend.
- `src/styles.css` (~384 lines): current styles, camelCase classes (`.chatPanel`,
  `.overlayFrame`), defines `--gold` etc.
- `index.html`: mounts `/src/main.tsx`.
- Routing is pathname-based: `/overlay` → overlay, `/tablet` → tablet, default →
  dashboard. No router library. Keep this approach.

## Target structure (split into modules)

This intentionally departs from the old "single-file frontend" convention. Update
`CLAUDE.md` to describe the new layout when the port is done.

```
src/
  main.tsx              # router only (pathname → page)
  mock/data.ts          # ported data.js, fully typed; export typed consts
  ui/icons.tsx          # Icon component + icon path set
  ui/shell.tsx          # NavBar, StatBar, Gauge, Panel, PopWindow, useDrag
  ui/panels.tsx         # Chat, ChatInput, Spotlight, EventFeed, RunSheet, MODULES,
                        #   badgesFor, ROLE_BADGE, EVT_ICON
  ui/tweaks.tsx         # useTweaks (localStorage) + Tweak* controls (no host protocol)
  pages/Dashboard.tsx   # cockpit App: layouts, popout layer, accent effect, Settings
  pages/Overlay.tsx     # existing overlay code, moved as-is (restyle in later phase)
  pages/Tablet.tsx      # existing tablet code, moved as-is (redesign in later phase)
  styles/tokens.css     # = colors_and_type.css
  styles/panel.css      # = panel.css (cockpit)
```

`pages/Overlay.tsx` and `pages/Tablet.tsx`: **move the existing backend-wired code**
(and the hooks/components they need — `useSocket`, `useChat`, `useMusic`, `useEmotes`,
`useSoundEvents`, `ChatPanel`, `MusicPanel`, `MusicControls`, `ControlSurface`) out of
`main.tsx` into modules so `main.tsx` is router-only. **Do not redesign them in this
phase** — just relocate so they keep working. They get the cockpit treatment later.

## Porting notes (Dashboard)

1. **`mock/data.ts`** — convert the IIFE to typed ES exports. Define types:
   `MockUser` (login, display, color, pronouns, roles, followed, subbed, seen, msgs,
   accountAge, note, recent: `{t, ago, kind?}[]`), `ChatLine` (user, text, time,
   highlight?), `FeedEvent` (kind, actor, detail, ago, tone), `RunItem` (text, done),
   plus `NAME` colors and `TICKER: string[]`. Export `USERS`, `CHAT`, `EVENTS`,
   `RUNSHEET`, `TICKER`.
2. **`ui/icons.tsx`** — port `Icon` (same SVG paths). Type `name` against the path keys.
3. **`ui/shell.tsx`** — port `useDrag`, `NavBar`, `StatBar`/`Gauge`, `Panel`,
   `PopWindow`. Replace `window.CP_DATA` reads with imports from `mock/data`. Keep the
   `mark.svg` `onError` fallback (asset is optional).
4. **`ui/panels.tsx`** — port the four modules + `MODULES` registry. The registry's
   `render(ctx)`/`count(ctx)` pattern stays; type `ctx` (`{ data, selected, selectUser,
   runsheet, toggleRun }`).
5. **`ui/tweaks.tsx`** — `useTweaks(defaults)` backed by `localStorage` (key e.g.
   `streamer-tools.tweaks`); `setTweak(key, val)`. Port `TweaksPanel` shell as a
   floating drawer with a visible open/close toggle (an icon button in `NavBar` or a
   FAB), plus the `Tweak*` controls actually used by the dashboard: `TweakSection`,
   `TweakRadio`, `TweakToggle`, `TweakColor`. Drop the host-protocol effects entirely.
6. **`pages/Dashboard.tsx`** — port `App` from `app.jsx`: `TWEAK_DEFAULTS`, `ACCENTS`,
   `POP_DEFAULTS`, the three `layouts`, the `slot()` helper, the popout layer, the
   accent-CSS-var `useEffect`, and the `Settings` page. `page` state toggles
   dashboard/settings; `selected` drives the spotlight; `runsheet` is local state with
   `toggleRun`. Import `tokens.css` and `panel.css` here (or in `main.tsx`).
7. **CSS** — copy `colors_and_type.css` → `styles/tokens.css` and `panel.css` →
   `styles/panel.css` verbatim. Keep kebab-case class names from the design (don't
   rename to camelCase — the design's classes and the existing `styles.css` classes
   coexist; just avoid `:root` collisions causing surprises — both define color vars,
   which is fine since names differ: `--gold-500` vs `--gold`).
8. **`main.tsx`** — router only: import pages, switch on `window.location.pathname`
   (`/overlay`, `/tablet`, default → Dashboard), keep the `overlayPage` body-class
   effect for the overlay route.

## Acceptance for Dashboard (Phase 2 review gate)
- `bun run dev`, open `http://localhost:5173/` → cockpit renders with mock data.
- Clicking a chat name updates the Viewer Spotlight.
- Run-sheet items toggle done/undone.
- Tweaks drawer opens; switching arrangement (cockpit/mission/modular), density,
  clock, accent, and starfield all take effect live.
- Settings page mirrors the same controls.
- Panels pop out into draggable/resizable floating windows and can re-dock.
- `bun run typecheck` and `bun run build` pass.

Then: review theme + interactions in the browser, iterate, and only afterward apply
the established theme/patterns to Tablet (stream-deck redesign) and Overlay (restyle).
