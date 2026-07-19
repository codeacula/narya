# design-sync notes — Narya

Repo-specific gotchas for future syncs. Read this before re-running anything.

## Shape: this repo is an app, not a component library

- There is no published `dist/` and no library build. `shape: "package"` with
  `srcDir: "src/client/ui"` bounds discovery to the UI kit; the converter runs
  in **synth-entry mode** (`[NO_DIST]` is expected, not an error).
- `node_modules/streamer-tools` is a **self-symlink to the repo root**
  (`ln -sfn ../ node_modules/streamer-tools`). The converter resolves
  `PKG_DIR = <node-modules>/<pkg>`, so without it the build dies with
  `ENOENT … node_modules/streamer-tools/package.json`. **Recreate it after every
  fresh clone / `bun install`** — node_modules is not committed.

## The .d.ts tree is mandatory — and generated

- Prop extraction (`lib/dts.mjs`) reads **only** a `.d.ts` tree; there is no
  source fallback. The components here use inline prop types, so no
  `<Name>Props` interface exists and the extractor falls back to each
  component's *call signature via the types entry*.
- Without this, every `<Name>Props` emits as `[key: string]: unknown` and the
  design agent gets **no API contract at all**. That is the single worst
  failure mode for this sync — always check one `.d.ts` after a build.
- `cfg.buildCmd` = `bash .design-sync/build-types.sh`, which runs
  `.design-sync/tsconfig.types.json` (declaration-only, `rootDir: src`) into
  `build/ts/` and then generates `build/ts/index.d.ts`.
- `package.json` carries `"types": "build/ts/index.d.ts"`. That field is what
  makes `findTypesRoot()` resolve to `build/ts` **and** `getSourceFile(entry)`
  succeed. Removing it silently reverts every component to an empty contract.
- The barrel is generated, not committed, so `src/` stays free of sync-only
  scaffolding. Adding a component to `src/client/ui/` needs no change here;
  adding a new *file* there means adding it to the barrel list in
  `build-types.sh`.

## Styling: `.cockpit` owns the dark surface

- `body` has **no background** in this app. The navy surface, ivory foreground
  and body font all come from `.cockpit` (`panel.css`). Preview cards render on
  a hardcoded white body, so **every authored preview wraps its content in
  `<div className="cockpit">`** or it renders as dark-on-white and looks broken.
- Because `.cockpit` is a class and not a component, `cfg.provider` cannot
  supply it — the wrapper has to live in each preview `.tsx`.
- Three stylesheets matter and the app loads all three: `styles.css` (base +
  overlay), `styles/tokens.css` (all `--*` tokens), `styles/panel.css`
  (cockpit + components). `tokensGlob: "src/client/**/*.css"` copies all three
  into `tokens/` so the whole set is reachable from the `styles.css` closure.
- **Known duplication:** `panel.css` ships twice — once as `tokens/styles/panel.css`
  (via `tokensGlob`) and once appended into `_ds_bundle.css` (via `cssEntry`).
  ~109 KB of redundancy. The rules are identical so there is no cascade hazard;
  `cssEntry` takes a single path and its `@import`s would dangle at bundle root,
  so this was the correct trade. Don't "fix" it by dropping `cssEntry` — that
  trips `[CSS_PLACEHOLDER]`.

## Preview authoring conventions

- Shared `PanelCtx` fixture lives at `.design-sync/previews/_fixtures.ts`
  (underscore prefix keeps it out of `<Name>.tsx` preview discovery). Six
  components take the same ctx — extend the fixture, never inline a second copy.
- **Never hardcode an absolute ISO timestamp** in a preview. `StatBar`'s ad
  countdown rendered as `1145236:30` from a fixed `adBreakEndsAt`. Compute
  relative to `Date.now()` (`inSeconds()` helper in `StatBar.tsx`).
- Wide components (`StatBar`, `NavBar`) need BOTH
  `cfg.overrides.<Name>.cardMode: "column"` and an explicit
  `viewport: "1440xH"` — `cardMode` alone governs the card grid, not the
  capture viewport, and the bar stays clipped at ~684px without it.

## What each component actually takes (learned the hard way)

Only `Chat` and `Spotlight` take `PanelCtx`. Everything else takes flat props:
`ChattersPanel {chatters, viewers, error, onOpenViewer}`,
`AttentionPanel {items, acked, settings, onAck, onSettingsChange}`,
`ShoutoutsPanel {shoutouts, streamActive, onOpenViewer}`,
`ControlsPanel {status, scenes, scenePrefix, currentScene, …}`.
Several components rendered as blank cards on the first pass purely because they
were handed a ctx they don't read and fell through to their empty branch —
**an empty card here is almost always missing props, not missing CSS.**

`Spotlight` additionally needs a `login` that resolves in `ctx.viewers`, and its
"Recent in chat" block is driven only by `viewer.recent`.

## `window.Narya` exports more than components

The bundle entry also exports `useToast`, `useDrag`, `belongsToCurrentSession`,
`mergeRecentChatters`, `sessionBoundaryIndex`, `MODULES`. Check that list before
concluding a hook-driven component can't be previewed:
`grep -o "__export(pkg_entry_exports, {[^}]*}" ds-bundle/_ds_bundle.js`.
This is what makes `ToastProvider` previewable — an inline consumer calls the
**real** `useToast().pushToast`, sharing module identity with the bundled
provider. (`pushToast({durationMs: 0})` defeats the 6 s auto-dismiss so a static
capture catches the toast.)

**The corollary is a silent trap.** Previews externalize *only* `'streamer-tools'`;
every other import is bundled into the preview IIFE. So
`import {…} from '../../src/client/auth'` compiles, runs, and mutates a **second
copy** of that module — the bundled component never sees it. No build error, just
a no-op. This is why `AuthGate`'s token-prompt state is unreachable: `auth.ts`
isn't in the barrel. Reaching it means adding `client/auth` to the barrel list in
`build-types.sh`, which widens the package's public surface — a deliberate call,
not a preview fix.

## Positioning: the app's layout ancestors don't exist in a card

Components positioned out of flow need their containing block recreated **in the
preview wrapper**, not via config:
- `TweaksPanel` is `position: fixed` → give the `.cockpit` wrapper
  `transform: translateZ(0)` so it becomes the containing block.
- `PopWindow` is `position: absolute` inside `.popout-layer` → wrapper needs
  `position: relative`.
- `.toast-stack` is `position: fixed` to the **viewport** corner, so toasts land
  on top of the provider's children. Hold children to ~460px wide so both read.

In every case give the wrapper an explicit content-sized width/height; a
full-viewport frame grades as mostly-empty navy.

## Driving self-stateful components

`ChatInput` holds its text in `useState` with no seeding prop, and setting
`input.value` directly does nothing (React never learns about it, so the send
button stays disabled and the card contradicts itself). Use the native setter:

```ts
const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
setter?.call(field, value);
field.dispatchEvent(new Event('input', { bubbles: true }));
```

React's synthetic `onChange` fires from that. Generalizes to any uncontrolled
component in the kit. Each cell is captured by its own page navigation
(`?story=<label>`), so module-level state never leaks between cells.

## `TweaksPanel` self-injects its CSS (don't go looking for it)

`.twk-panel`, `.twk-hd`, `.twk-body`, `.twk-sect`, `.twk-x` appear in **none** of
the three stylesheets — they are in a `<style>` block inside
`src/client/ui/tweaks.tsx`, so they ride in the JS bundle. A grep of the shipped
CSS for `twk-` returns zero and looks alarming; the component is fine. Verified
by rendering. (`.twk-toggle` / `.twk-overlay-bounds` / `.twk-warn` are written by
`src/client/overlayPlaceholders.tsx`, not by a stylesheet either.)

Practical consequence: **`_ds_bundle.css` is not the whole styling story** for
this DS. Any audit that reasons only from the CSS files will mis-report
components that inline their own styles.

## Token vocabulary corrections

- **Correction — `--accent-fg` IS a real token.** A wave reported it missing and
  that was wrong; it is defined in `panel.css`'s `:root` block as
  `var(--gold-400)`, together with `--accent` (`--gold-500`) and `--accent-soft`.
  Both `--fg-accent` and `--accent-fg` exist. The false report came from grepping
  only `tokens.css`; **always grep the full closure**
  (`tokens/styles.css` + `tokens/styles/*.css` + `_ds_bundle.css`).
- The genuinely undefined references are `--warning` (bare — the family is
  `--warning-base/-fg/-bg/-border`) and five set from JS at runtime:
  `--orb`, `--reward-color`, `--overlay-text-accent`, `--clip-aspect`,
  `--clip-width-from-height`. Recompute with:
  `grep -oE "var\(--[a-z0-9-]+" … | sort -u` diffed against the `--x:` definitions.
- Status hues that exist: `--fg-1/2/3`, `--fg-accent`, `--fg-arcane`,
  `--success-fg`, `--warning-fg`, `--danger-fg`, `--info-fg`, `--note-fg`.
- `formatAgo` (`src/shared/time.ts`) renders sub-hour ages as `m:ss`, so
  attention rows showing `12:00` are correct, not a broken fixture. Don't
  "fix" it by moving fixtures to hour-scale ages — that hides real formatting.

## Toolchain gotchas

- **npm 12 blocks postinstall scripts by default.** `npm i esbuild` in
  `.ds-sync/` installs no binary and the build fails on import. Fix:
  `npm install-scripts approve esbuild && npm rebuild esbuild`.
- **No playwright browser download needed.** System chromium at
  `/usr/bin/chromium` works via `DS_CHROMIUM_PATH=/usr/bin/chromium`. Install
  the package with `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm i playwright`.
  Every validate/capture command must carry that env var.
- Changing `cfg.overrides` or `cfg.titleMap` requires a full
  `package-build.mjs` — `preview-rebuild.mjs` fails `[CONFIG_STALE]`.
- A **scoped** `package-capture.mjs --components A,B` prunes the review sheets
  of components not named. Recapture together before grading a set.

## Deliberately not covered (do not treat as regressions)

- **`ServiceStatusToasts` is `cfg.overrides…skip`.** The component is
  `return null` — it has no markup at all. Its entire output is toasts pushed
  into `ToastProvider` from three `useSocket` subscriptions, and the
  `dashboard:status` handler drops the first snapshot by design, so even a live
  socket needs two frames. The capture harness serves static files with no
  `/socket`. Its real rendered output IS covered — the `ToastProvider` cells use
  the same `pushToast` path with copy lifted verbatim from `serviceStatus.tsx`.
  Stubbing `window.WebSocket` was rejected: the screenshot would show
  ToastProvider's markup under a ServiceStatusToasts label.
- **`AuthGate`'s token-prompt screen** — unreachable, see the second-module-copy
  trap above. Only `PassThrough` is authored, deliberately.
- **`AttentionPanel`'s settings popover** — behind internal `settingsOpen` state
  with no prop to force it open.
- **`ChatInput`'s sending/error states** — reachable only by submitting against a
  backend that isn't running during capture; forcing it makes the sheet flaky.
- **`ControlsPanel`'s muted state** — `MediaMuteToggle` reads `useMediaMute()`
  internally rather than taking a prop, so it always seeds to the `UNMUTED`
  fallback. The warning banner and `is-muted` styling need a source change
  (a prop or provider) to become previewable.

## The converter narrows `| null` — corrected via `dtsPropsFor`

The prop extractor strips `| null` from every emitted `<Name>.d.ts`, so
`currentScene: string | null` shipped as `currentScene: string`. That is a
**contract the design agent codes against**, and the app really does pass null.
`cfg.dtsPropsFor` carries hand-written bodies restoring the true types for
`StatBar` (15 nullable props), `ControlsPanel` (`currentScene`) and
`ChattersPanel` (`error`), copied verbatim from `build/ts/client/ui/*.d.ts`.
**If a component gains a nullable prop, add it to `dtsPropsFor` too** — nothing
detects this automatically, and the emitted `.d.ts` will silently lie.

## Known render warns (triaged, expected)

- `[FONT_REMOTE]` — Cinzel / Cormorant Garamond / Montserrat / JetBrains Mono
  load from a Google Fonts `@import` at the top of `tokens.css`. Intentional:
  they resolve at runtime, nothing to ship in `fonts/`. "Trajan Pro" and
  "Iowan Old Style" appear only as fallback-stack entries and are never fetched.
- `tokens: 2 missing` (below threshold) — referenced-but-undefined custom
  properties in `panel.css`. Non-blocking.

## Re-sync risks

- **The self-symlink and `build/ts/` are both gitignored and both required.**
  A fresh clone must run `bun install`, recreate the symlink, and run
  `cfg.buildCmd` before the converter, or the run either dies (`ENOENT`) or
  silently emits 19 empty prop contracts. The empty-contract failure is the
  dangerous one — it exits 0.
- `package.json`'s `"types"` field points at gitignored generated output. It is
  inert for the app (private package, never consumed as a library) but a future
  cleanup that "removes the dead types field" would break this sync silently.
- Preview fixtures are hand-written data typed against `src/shared/api.ts`. A
  change to `ChatEntry`, `StreamEvent`, `Viewer` or `PanelCtx` will fail the
  preview compile (component drops to the floor card) — the compile error is in
  the **build** log as `! preview build failed: <Name>`, not in validate.
- `StatBar` previews render a `Date.now()`-relative countdown, so its screenshot
  differs byte-for-byte on every capture. Grades key off the `.tsx`, so this
  does not churn grades — do not "fix" it back to a fixed timestamp.
- Components were synced with all 19 in group `general`. The group heuristic
  derives from the source directory, and everything lives in `src/client/ui/`.

## Driver invocation: export DS_CHROMIUM_PATH

`resync.mjs` spawns validate as a child, so the browser path must be in the
**environment**, not just on the validate command line:

```sh
export DS_CHROMIUM_PATH=/usr/bin/chromium
node .ds-sync/resync.mjs --config .design-sync/config.json \
  --node-modules ./node_modules --out ./ds-bundle
```

Without the export the driver's validate stage exits 1 with `[RENDER_SKIPPED]`
and the verdict comes back `ok: false` while a standalone validate exits 0 —
confusing, and it looks like a real failure. Same applies to `package-capture.mjs`.
