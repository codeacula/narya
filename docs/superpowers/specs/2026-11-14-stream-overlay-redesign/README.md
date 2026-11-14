# Stream overlay redesign — handoff

Date: 2026-11-14. Status: steps 1–5 implemented on `main` (a20e05a..a9fa9d3), verified by tests and static-harness screenshots only — not yet checked in OBS against live data.

Resolved since writing: Code chose to stay at 1080p for now (1920×1080 sources, mockup px values); the "nothing playing" idle state for now-playing is approved. The LLM-managed pinned card is still not built and still needs Code's rule before anything pins viewer text automatically.

This is a handoff for implementing the Codeacula stream overlay redesign in Narya. The look was designed and approved as mockups; this document turns it into an ordered build plan. Read the repo's `CLAUDE.md` first — its rules on verification, overlay routes, the overlay event allowlist, and commits all apply here.

## Goal

Make Narya's OBS browser-source overlays match the Codeacula Design System and add the pieces the stream needs that do not exist yet: top and bottom info bars, an ad-break banner, a pinned card, and full-screen Starting soon / Be right back / Ending scenes.

## Reference material

Everything is in `mockups/` next to this file. Each scene has a `.jpg` (what it should look like at 1920×1080) and a `.html` (the mockup source — every element carries its exact values as inline styles, so read it for sizes, colors and spacing).

| File | Scene |
| --- | --- |
| `Main` | Live scene (coding or game): top bar, capture, chat above webcam bottom-right, bottom bar |
| `AdsLive` | The ad-break banner layered over the Live scene |
| `Chatting` | Just chatting: top bar, large webcam, topic and chat in a right column, bottom bar |
| `Alerts` | Alert cards (follow, sub, raid, cheer) and the pinned card (viewer question or own topic) |
| `Starting`, `Brb`, `Ending` | Full-screen holding scenes: starfield, orb, headline, chat, with the same top and bottom rows drawn as hairline rules instead of filled bars |

The mockup `.html` files are design-tool artboards: they reference a `./support.js` that is not included, and their wrapper tags (`x-dc`, `helmet`) are not real HTML. Treat them as a readable spec, not as code to copy. The striped "screen capture" and "webcam" blocks are placeholders for OBS sources and must not be built — those regions stay transparent.

The hosted canvas is at https://claude.ai/artifact/FpuqPyWozX2mTAQxYk4HRF (private to Code).

## Design rules

These come from the Codeacula Design System and were followed in the mockups.

- **Tokens.** Use the variables already in `src/client/styles/tokens.css`. The mockups use raw hex only because the design tool could not load the tokens; map them back (`#1c273e` → `--navy-800`, `#131b2d` → `--navy-900`, `#0c1220` → `--navy-950`, `#fdfcf0` → `--ivory-50`, `#e8e4cf` → `--ivory-200`, `#a2aabc` → `--silver-400`, `#ffb86c` → `--gold-500`, hairline `rgba(162,170,188,0.18)` → `--border-1`, standard border `rgba(162,170,188,0.32)` → `--border-2`, gilded `rgba(255,184,108,0.45)` → `--border-3`).
- **Type.** Cinzel for the wordmark only (uppercase, 0.22em tracking). Cormorant Garamond for headlines and the italic "saying" voice. Montserrat for body. JetBrains Mono for eyebrows (uppercase, 0.16em tracking), usernames, timers and metadata.
- **Surfaces.** Flat `--navy-900` at roughly 88–96% opacity, 1px hairline border, 4px radius. No backdrop blur, no drop shadows, no thick colored top or left borders.
- **Gold is one thing at a time.** Per scene, gold marks a single live value: the uptime in the bottom bar, the countdown on Starting soon and on the ad banner.
- **Alert colors** come from the alert palette in `tokens.css`: follow = silver, sub = gold (`--warning-*`), raid = violet (`--note-*`), cheer = blue (`--info-*`). Each card uses the matching `-bg`, `-border`, `-base` (icon) and `-fg` (eyebrow).
- **No emoji.** Icons are 1.5px-stroke line icons.
- **Motion** is slow and gentle; no bounces or springs.
- **Chat always sits directly above the webcam.** The one exception is Just chatting, where the webcam is the main subject and chat sits in a column beside it.
- **Two bars frame every scene.** The top bar is the community: latest follower, sub, bits and raid in four fixed slots. The bottom bar is Code: wordmark, an operator-written line, then now-playing and stream uptime on the right. Both are 48px tall on the 1080p mockups. On the holding scenes the same two rows are drawn without a fill, as a hairline rule with the content sitting on the starfield.
- **Target resolution is 1440p.** Code streams at 2560×1440. The mockups are drawn at 1920×1080; everything scales by 4/3 (48px bars become 64px). Narya's overlays are currently built for a 1920×1080 browser source, so decide how to scale — a 1920×1080 source stretched to the canvas in OBS, or layouts in relative units — and confirm it with Code.
- **Legibility.** Stream text is 18px or larger at 1080p (eyebrows may be 14px).

## What Narya has today

Verified by reading the repo on 2026-11-14 (branch `main`, clean tree). Re-check before relying on it.

- Overlays are separate transparent browser sources, routed by `overlayFromPath` in `src/client/routing.ts` and rendered from `src/client/pages/Overlay.tsx`: `/overlay` (combined chat + now-playing), `/overlay/chat`, `/nowplaying`, `/clips`, `/sounds`, `/shoutouts`, `/status`, `/text` (alias `/overlay/alerts`), `/winddown`.
- Overlay styles live in `src/client/styles.css`. The current text/alert card (`.overlay-text-body`) has a 14px radius, backdrop blur, a drop shadow, a 4px colored top border and off-palette accents (`#8be9fd`, `#bd93f9`, `#d0d4dc`). The wind-down card and chat rows are in the same file.
- The combined `/overlay` puts chat top-right (`.overlay-chat`) and now-playing bottom-left (`.overlay-goals`).
- The overlay WebSocket allowlist is `OVERLAY_EVENTS` in `src/server/auth.ts`. It has no ad-break event.
- Ad-break state exists server-side: `state.adBreakEndsAt` is set in `src/server/eventsub.ts`, cleared in `src/server/dashboard/status.ts`, and currently reaches only the operator dashboard via `DashboardStatus`.
- `src/client/windDown.ts` plus `OverlayWindDownPage` is the existing pattern for "REST seed + one WebSocket event + client-side countdown". The ad banner should follow it.

Not inspected: the chat, music and shoutout components themselves (`chat.tsx`, `music.tsx`, `shoutouts.tsx`), the overlay token's GET allowlist, and what the overlay role can already read about latest follower/sub or uptime.

## Build plan

Do these in order, one focused commit each. Steps 1–3 are the core; 4 and 5 can follow later. All five are in scope.

### 1. Restyle the existing overlays (CSS only)

Bring chat rows, now-playing, text/alert cards, shoutout ticker, status text and the wind-down card in line with the design rules above. No route, payload or contract changes.

- Now playing moves into the bottom bar (step 2): a line-icon note, then track title and artist on one line. The standalone `/overlay/nowplaying` source stays (it is in scene collections) and should be restyled to match. It keeps the existing `MusicPanel` data (title, artist, paused/idle states); decide how paused and "no music" should look, since the mockups only show a playing track.
- Chat rows: see the three chat lines in `mockups/Main.html` (username in mono, role color; message in Montserrat 18px; `--navy-900` at 88%; hairline border; 4px radius).
- Text/alert cards: see `mockups/Alerts.html`. Map the existing `tone` values to the alert palette instead of the current hex accents; keep the three placements (banner, toast, centered).
- Move chat in the combined `/overlay` from top-right to bottom-right, leaving room below it for a 400×225 webcam and the 48px bottom bar (see `mockups/Main.html` for the exact offsets).

### 2. Top and bottom bars

Two full-width bars, 48px tall at 1080p, `--navy-900` at 94% with a hairline rule on the inner edge. Spec in `mockups/Main.html`.

- **Top bar:** latest follower, latest sub, latest bits (name and amount), latest raid (channel and viewer count), spread across four slots with thin separators.
- **Bottom bar:** orb mark and CODEACULA wordmark, the operator-written "now" line, then on the right now-playing (note icon, track, artist) and stream uptime in gold.

The bars should be their own browser sources so each can be switched off per scene (Code may hide the top bar for some games). The existing shoutouts data (`/api/dashboard/session-shoutouts`) is the likely source for the top bar. Open question to resolve by reading the code: whether these extend `/overlay/status` and `/overlay/shoutouts` or are new routes, and which fields the overlay role can already read. Anything new sent to overlays must carry no operator configuration and must be added to `OVERLAY_EVENTS`.

### 3. Ad-break banner

A new `/overlay/ads` browser source that is empty (transparent) unless an ad break is running. When one is, it shows a 120px band across the top, covering the top bar: orb, eyebrow "ad break", "Ads are running · you are not missing anything", and a gold "back in mm:ss" countdown. Spec in `mockups/AdsLive.html`.

- Add an overlay-allowed event carrying only the ad-break end time (and nothing else from the ad schedule), plus a GET on the overlay token's read allowlist so the source can seed itself.
- Tick the countdown client-side from the end time, as wind-down does; hide the banner when it reaches zero or the server clears the state.
- Add the route to `overlayFromPath`, cover it in `routing.test.ts`, and make sure it gets the shared `OverlayPlaceholder`.
- The text is deliberately large: it needs to be readable when the stream is shrunk during an ad.

This is the only ad-break UI. A full-screen ad scene and a banner over Just chatting were considered and dropped — for longer breaks Code will switch to Be right back.

### 4. Starting soon, Be right back, Ending

Three full-screen routes sharing one layout: starfield background, centered crystal-ball orb with a dashed orbit ring, eyebrow, large Cormorant headline, italic line, and the last four chat messages bottom-right. The top and bottom rows carry the same content as the bars on the live scenes, but with no fill: a hairline rule and the content directly on the starfield. The bottom row's operator line is "today" on Starting soon and Be right back, and "next stream" on Ending. Specs in `mockups/Starting.html`, `Brb.html`, `Ending.html`.

- The orb is CSS (layered radial gradients); the classes are in each mockup's `<style>` block. The "arcane" variant is used on Starting soon, "moon" on the other two.
- The starfield in the mockups is two layers of radial-gradient dots with a very slow drift and twinkle. Code wants a more visibly animated background eventually; a port of his `deep_space.glsl` shader (in the design system's assets) is the intended upgrade. Build the CSS version first unless told otherwise.
- No social links — they were removed on purpose.
- Uptime is silver on all three holding scenes, so the countdown is the only gold element.
- Starting soon and Be right back each have a gold countdown under the italic line. The Be right back countdown tells viewers when Code plans to return: he sets the duration from Narya when he switches to the scene (and should be able to adjust or clear it). Tick it client-side from an end time, like wind-down. When it reaches zero it keeps counting into negatives (for example `-02:15`), so viewers can see he meant to be back by then and is running late; it does not stop, hide or reset on its own. Starting soon behaves the same way. Build one shared countdown (one component, one formatter) for Starting soon, Be right back and the ad banner where it fits, so they all tick and format identically; `windDownCountdown.ts` is the existing formatter to reuse or extend. Ending has no countdown.
- Bracketed text in the mockups (`[what I am building today]`, `[day and time]`) is operator-entered text controlled from Narya — see "Decisions already made". Viewer names, track info and timers come from live data.

### 5. Pinned card

One card that Code can put on stream and leave up while he talks. It has two uses, and they share one slot — showing one replaces the other:

- **A viewer question.** Pin a chat message: the card shows "<name> asks" in mono (`--gold-400`) and the question in Cormorant italic.
- **A topic of his own.** Free text he types: the card shows the eyebrow "topic" in silver and the text in the same italic.

Spec in `mockups/Alerts.html` (right column): 720px wide, `--navy-900` at 94%, standard border, 4px radius, 34px italic text. On stream it sits bottom-left, directly above the bottom bar.

What it needs:

- An operator control in the dashboard (and ideally the tablet) to pin a chat message, set a custom topic, and clear the card. Pinning a message should be an action on a chat row.
- A small persisted state (current card or none) with a REST seed and one overlay-allowed event, like wind-down. The payload carries only what is displayed: kind, display name, text.
- A new overlay route for it, added to `overlayFromPath`, `routing.test.ts` and `OVERLAY_EVENTS`.
- Moderation: if the pinned message is later deleted or its author is timed out or banned, the card must clear. The overlay already hides moderated chat; this must not become a way around that.

Code is also interested in letting an LLM manage the card so he does not have to (for example, noticing a real programming question in chat and pinning it, or clearing a stale one). Do not build that in the first pass. Make set/clear available as Action steps so that the existing automation and `llm_response` machinery could drive it later, and raise the design with him before adding any automatic pinning — anything that puts viewer text on stream unprompted needs a clear rule for what is allowed.

Host and guest lower thirds were considered and dropped. The mockups no longer include them.

## Decisions already made

- Chat above the webcam everywhere except Just chatting.
- Ad break is a banner over the Live scene only.
- No socials on the holding scenes.
- Chat and now-playing are shown on the holding scenes.
- Now playing lives in the bottom bar on every scene; there is no floating now-playing chip.
- A side-panel layout (capture shrunk to the left, everything else in a right-hand panel) was mocked up and rejected in favor of the two bars.
- The pinned card is in scope, for viewer questions and Code's own topics. Host/guest lower thirds are out.
- Just chatting keeps its current layout: large webcam, with topic and chat in a column beside it.
- The operator-written text — "now" in the bottom bar, "talking about" on Just chatting, the "today" and "next stream" lines on the holding scenes — is entered and controlled by Code from Narya (dashboard and/or tablet), not derived from the Twitch title. This needs a small operator-editable store, a control surface, and an overlay-readable payload; `streamStatus.ts` (the persisted status line behind `/overlay/status`) is the closest existing pattern, so check whether it can be extended before adding something new.
- Placement of individual browser sources in OBS stays Code's job; only the combined `/overlay` layout changes.

## Things to confirm with Code

- Step 1 changes how the live overlays look on the next stream — he has seen the mockups and likes the look, but has not explicitly said "go" on the Narya changes.
- How (and whether) an LLM should be allowed to manage the pinned card — see step 5.

## Verification

Per `CLAUDE.md`: `bun run typecheck`, `bun run build`, `bun test` where behavior is covered, endpoint smoke tests after backend changes, and a visible Chromium check of each overlay at 1920×1080 against the matching `mockups/*.jpg`. Use `STREAMER_TOOLS_DB` pointed at a scratch database; do not touch `data/streamer-tools.sqlite`.
