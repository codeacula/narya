# Dashboard — Codeacula Design System alignment

Date: 2026-11-14. Follows the stream overlay redesign (`2026-11-14-stream-overlay-redesign/`).

## Goal

The overlays now follow the Codeacula Design System. The dashboard, tablet, viewers and
settings already load the same tokens (`tokens.css`) and fonts, but drifted from the
overlay's visual rules. Bring the operator surfaces in line, reuse the overlay's own
elements where they fit, and record the trouble areas found on the walkthrough.

## How the overlay rules translate to an operator surface

The overlay rules were written for a 1080p browser source. The dashboard is a dense tool
read at arm's length, so each rule is adopted with the adjustment noted.

| Overlay rule | Dashboard adoption |
| --- | --- |
| Flat `--navy-900` surfaces, 1px hairline, 4px radius; no blur, glows, drop shadows | Panels, cards, chips and buttons go flat at `--radius-2`. No backdrop blur, no decorative glows. Floating windows (modals, popouts, menus) keep `--shadow-3`: they float over live content and need separation, which a stream card does not. |
| No thick coloured top/left borders | Panel gold left stripe, chat-row highlight stripe and attention-row stripe go. Highlight state is carried by a palette `-bg` tint, the row's tag chip and (for mentions/unacked alerts) a 1px palette hairline. |
| Alert palette: follow = silver, sub = gold, raid = violet, cheer = blue | Same mapping for the event feed, attention feed and shoutout chips. Follow moves from violet to silver. Same line glyphs as the overlay alert cards. |
| Mono usernames, role-coloured | Chat usernames go mono. |
| Cinzel wordmark, uppercase, 0.22em | Navbar wordmark at 0.22em with the crystal orb mark (the old `/assets/mark.svg` does not exist and 404s). |
| Cormorant for headlines and the italic "saying" voice | Attention rows read like the overlay alert cards: mono eyebrow, Cormorant italic name, body detail. |
| Gold is one thing at a time | Gold stays the operator accent (active nav, primary action, focus). Decorative gold goes: panel-title dots and the attention pulse move off gold. Live uptime turns gold, matching the bottom bar. |
| Pills are not used | Tags, chips, counts and segmented controls move from pill to `--radius-1`/`--radius-2`. Dots, avatars and switch knobs stay round. |
| Crystal orb | Empty states use the overlay's `CrystalOrb` (moon) instead of the violet blob. |
| 1.5px line icons, no emoji | `Icon` stroke goes from 1.6 to 1.5. |

Out of scope: overlay CSS (already done, and live in OBS), layout changes, new features.

## Order

1. Shared elements: orb mark, empty-state orb, alert glyph icons, stroke width, tone mapping.
2. Flatten surfaces: panels, radii, pills, glows, blur.
3. Rows: chat, attention, event feed, tablet.
4. Walkthrough, trouble-area report (below), verification.

## What shipped

- **Shared elements.** The navbar mark is the overlay's `CrystalOrb` (arcane), next to a
  0.22em Cinzel wordmark. Every empty state uses the moon orb (14 sites). `Icon` gained
  the four alert glyphs (sparkle, planet, raid, gem) plus arrow-up and arrow-down, and
  draws at 1.5px. The event feed, attention feed and shoutout chips use the alert palette,
  so a follow is now silver everywhere. `EVT_TONE_OVERRIDE` (which forced follows to violet) is gone and the event feed
  uses the tone the server stores, which already follows the palette.
- **Surfaces.** Panels, tablet panels, cards, modals, toasts and alerts are flat at
  `--radius-2`. Pills became `--radius-1` (tags) or `--radius-2` (buttons) at about 45
  sites; dots, avatars and the switch track stay round. Removed:
  - the navbar and modal blur;
  - the panel tint and gold stripe;
  - decorative glows on dots, scene buttons and the send button. Orb glows stay.
  - the off-palette `#50fa7b` green and `#ffe2bf`.
- **Rows.**
  - Chat usernames are mono and role-coloured, with no colon.
  - Highlights are palette `-bg` fills with no stripe. Mentions and selected rows add a
    1px palette hairline.
  - Attention rows are miniature alert cards: mono eyebrow, Cormorant italic name, the
    tone's `-bg` and `-border` while unacked, and a slow breathing hairline instead of a
    gold pulse.
- **Gold.** Live uptime is the stat bar's gold value, as in the bottom bar. The primary
  button is filled gold rather than violet. Panel-title dots are silver.

## Walkthrough — trouble areas

The walkthrough ran on a throwaway instance (port 4319/5174, scratch DB with seeded chat
and events, no credentials) plus two read-only code audits. Each item below was checked
against the code.

### Fixed in this pass

| Problem | Failure | Fix |
| --- | --- | --- |
| Removed chat looked live | `/api/dashboard/chat` and `/api/viewers/:login/messages` never selected `deleted_at`. A message Twitch or a mod removed rendered as normal chat with pin, timeout and ban offered, even though the `chat:moderated` refetch says it exists "so every surface shows the same soft-deleted rows". | `ChatEntry` carries `deletedAt` and `deletedReason`, one column list feeds all four queries, and the row is struck through with the reason and has no actions. Tagged-chat attention skips it. Covered by `dashboard/chatEntries.test.ts` and `attention.test.ts`. |
| Ages read as clock times | `formatAgo` returned `15:27` for "15 minutes 27 seconds ago", beside chat's `6:07 PM`. | Always unit-suffixed: `15m ago`, `2h 5m ago`. `shared/time.test.ts`. |
| Brand mark 404 | `/assets/mark.svg` was never shipped, so every page load 404'd and the mark hid itself. | `CrystalOrb`. |
| Twitch Disconnect | No confirm, failure only went to `console.error`, and it was styled as the primary call to action. | Confirms with the consequence, toasts on failure, styled danger. |
| Trigger delete | The confirm said "Delete this trigger?" while four seeded triggers sit side by side. | Names the trigger. |
| Stream Info tags | The empty chip well rendered as a second, dead text box. | Hidden when empty; the input has a placeholder. |
| Triggers list head | The hint was squeezed into about 110px beside the kind picker. | Stacked. |
| Apps hint | JSX whitespace dropped the space: "sourcevalue". | `{' '}`. |
| Accessibility | Icon-only buttons had only `title`. `↑`/`↓` glyphs were read as "up arrow". The chat name was a clickable `<span>`. `SettingsStatus` was not announced. | `aria-label`s, `Icon` arrows, the name is a `<button>`, `role=status`/`alert`. |

### Follow-up (closed)

The twelve items below were open when the walkthrough ended. A follow-up on
`fix/open-settings` closed them; each was checked against the code first, and two
premises turned out to be wrong (#2, #3). Shared pieces live in `ui/` and
`pages/settings/shared.tsx` and are documented in their own comments.

1. **Unsaved edits are lost silently.** `ui/dirtyGuard.tsx` (logic in
   `dirtyGuardLogic.ts`) gives `useDirtyGuard`/`useDraft` and a `beforeunload` handler
   while anything is dirty. Every settings editor reports to it, as do Stream Info, both
   viewer modals, the Controls panel drafts, and the `/viewer` popout (`main.tsx`). The
   nav and Back/Forward ask before leaving (`Dashboard.tsx`, `leaveThen` and the
   popstate handler). Cancel and Close in the reward, counter, quote, Action and module
   editors go through `discardThen`, and a clean one closes at once. A freshly minted
   app token asks its own question, because it cannot be recovered
   (`AppsPage.tsx`). Reward groups compare as a set, so re-ticking one is not an edit.
   The single-object forms cannot be edited before they have loaded (#8), so a failed
   load can no longer leave an unguarded draft.
2. **Tablet ban targets.** The premise was half wrong: the arm already disarmed after
   4 seconds as well as on blur (`ARM_TIMEOUT_MS` in `ui/panels/Chat.tsx`), not only on
   another touch. The size was real. Tablet `.msg-mod-btn` is now 44px tall and at least
   56px wide with 12px gaps, and ban sits at the far end behind a hairline. Checking the
   armed state found a worse fault: touch leaves `:hover` on the last button tapped, and
   the tablet's button chrome then overrode the armed fill, so "sure?" was unreadable.
   The armed colours are restated for `:hover`/`:active` (`panel.css`).
3. **Keyboard reach of row actions and times.** The premise was wrong: the actions were
   already in the tab order and `.msg-mod:focus-within` revealed them, so the row did
   not need to be focusable. What failed was focus on the name button (each row's first
   stop) revealing nothing, the time never appearing from the keyboard, and Chromium's
   near-black default focus ring on the actions. `.msg:has(:focus-visible)` now reveals
   time and actions, a click does not, an armed ban stays visible, and name and action
   buttons share the gold focus ring. The tablet and viewer history show times
   outright. No other hover-only reveal is left in `panel.css` or `styles.css`.
4. **One feedback pattern.** `SettingsStatus` is the only saved/failed line in settings,
   with its live regions always mounted; `SettingsAnnouncer` holds those regions where
   the drawn line sits inside a swapped branch (LLM and TTS enable, the viewer roster,
   the viewer record). The rule is written down in `shared.tsx`. Apps events and
   tokens, Content, Connections errors, the Twitch Disconnect and Categories (which
   reported only failures) all follow it. Settings saves raise no toast; the one
   settings toast is "Settings saved elsewhere", when another window saved
   (`settingsEcho.ts`).
5. **One confirm pattern.** `useConfirm`/`ConfirmDialog` (`ui/confirm.tsx`) replace
   every `window.confirm`. Irreversible deletes take `requireText`: the reward delete
   and the viewer flush. VIP/mod revokes, override and app-event removals, token
   rotate/revoke and the Tengwar key clear now confirm too.
6. **Modals are dialogs.** `ui/modal.tsx` (logic in `modalLogic.ts`) gives role
   `dialog`, `aria-modal`, a focus trap and Escape. Stream Info, the Discord help,
   both viewer modals and `ConfirmDialog` render through it.
7. **One word for a service that is not connected.** `connectionWords.ts` says
   connected, connecting, offline or unknown, and the stat bar (`statBarText.ts`), service
   toasts (`serviceTransitions.ts`), the tablet, Live Data, Connections
   (`connectionCopy.ts`), the voice picker (`ttsVoiceCopy.ts`) and the AutoMod notice use
   it. The tablet shows "OBS offline" (`obsNotice.ts`) instead of the raw socket error,
   hides the studio state while OBS is unreachable, and its chip reads "Unknown" until a
   status has arrived. A missing channel reads "not set".
8. **No false empty states.** `EmptyState` (`ui/emptyState.tsx`) draws every true empty
   state. `listFace` (`pages/settings/listState.ts`) keeps a failed list apart from an
   empty one, with `ListUnavailable` and a Retry that keeps focus while it runs.
   `formFace` does the same for Connections, Go live, Wind-down, Speech and AI:
   `FormUnavailable` replaces the fields until a load succeeds, so a failed load can no
   longer save code defaults over stored config. Stream Info stays unsavable until its
   live values have loaded. `suggestionFace` (`suggestions.ts`) makes a failed category
   or tag search say so instead of "No matches". Values read once (mute, wind-down,
   holding scene, pinned card, overlay bounds) carry a known/unknown status
   (`liveValue.ts`, `controlFaces.ts`), and the modules' live state, the tablet
   soundboard, AutoMod, chatters and the media New form wait for a real answer.
9. **Attention overflow.** A fade and "n more below", measured on scroll, resize and
   row changes (`attentionOverflow.ts`, `AttentionPanel.tsx`).
10. **Silent background refreshes.** `refreshHealth.ts` and `StaleNotice` mark the
    roster, rewards, feeds and shoutouts last-known when a refresh fails. The stat bar
    dims and reads "last known · Narya not answering" while the socket is closed or the
    last refresh failed (`statusIsStale`, `useSocketState` in `realtime.ts`).
    `latestOnly.ts` stops a slow failed refresh landing over a newer good one.
11. **One header path.** Every settings route renders `SettingsHeader`, with counts and
    actions passed as data (`headerCounts.ts`). The static inline styles moved into
    classes; what remains is dynamic (role colours, drag positions, orb sizes, scene
    column count).
12. **Dead CSS.** Done here after all rather than in an overlay pass. `ChatPanel` is now
    the compact overlay chat it always was, the overlay-era `.chat-message` rules and
    13 other unused selectors are gone, and the overlay still renders
    `chat-panel compact` with the same output. The unused `QuickActionsPanel` was
    removed (`quickActions.tsx` says why), and the last text glyphs used as icons
    (`×`, `◆`, `!`, `i`, `→`, the `?` nav avatar) are line icons.

### Deliberate exceptions and remaining notes

- **Chat-row ban arms in place.** First tap shows "sure?", second bans, blur or 4
  seconds disarms. A modal would cover the message being acted on mid-stream. It is the
  one exception to `useConfirm`, recorded in `ui/confirm.tsx`; do not copy it.
- **AI's Reset discards without asking.** It is the explicit "throw away my edits"
  button and is disabled while the form is clean. Every Cancel and Close asks.
- **Back/Forward re-pushes.** With a dirty draft the browser has already moved the URL,
  so the handler pushes the shown page back and, on agreement, pushes the target. The
  entry being left becomes the newest one rather than history stepping cleanly.
- **Floating panels are not modals.** `PopWindow` and the Tweaks panel float beside
  live content without trapping focus.
- **Inline editor notes stay `.command-empty`.** "No steps yet", "No categories
  claimed" and "No reward groups" sit beside the control that fills them, per
  `ui/emptyState.tsx`; they are not empty states.
- **A few quiet catches remain, all decorative.** The debounced `refreshViewers` in
  `chatFeed.ts`, and emotes and channel on the overlay.
- **Overlay sources read a failed overlay-bounds GET as off.** Only the dashboard switch
  shows it as unknown; boxes over a live stream are the bad state.
- **A successful Retry drops focus to the page.** The list replaces the unavailable
  face. Focus is kept only while the retry is in flight.
- **Not browser-checked.** The chatters "Gathering your viewers…" and AutoMod "Loading
  held messages…" faces are transient on a scratch instance and are covered by unit
  tests only.
