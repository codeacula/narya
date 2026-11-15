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

### Still open, most important first

1. **Unsaved edits are lost silently.** No settings editor has a dirty guard or a
   `beforeunload` handler (only `LlmSection` and `StreamCategoriesPage` track dirty at
   all). A rail click mid-way through a multi-step Action or a trigger's conditions
   throws the draft away. Fix: a shared `useDirtyGuard` that confirms on navigation.
2. **The tablet's ban is one small gap from pin and 10m.** The row buttons are the
   36px minimum with 8px gaps, and the first tap arms "sure?", which any other touch
   disarms. Raise them to 44px and set ban apart (`panel.css` `.tablet-shell .msg-mod-btn`).
3. **Dashboard row actions and times are hover-only.** `.msg-mod` and `.msg-time` reveal
   on `:hover`. The name button is now focusable, but the actions still need the row to
   be focusable to reach them from the keyboard.
4. **Five feedback patterns** for "saved" and "failed": `SettingsStatus` in 12 files,
   `set-status` in GoLive and Rewards, `viewers-status`, `viewer-record-note`, and
   toasts. Converge on `SettingsStatus`; it now has the live-region role.
5. **Three confirm patterns** for destructive actions: `window.confirm` at 13 sites,
   Flush's in-place two-step, and the ban/timeout modal. Irreversible Twitch-side deletes
   (a reward) get the same one-click browser confirm as local ones.
6. **Modals are not dialogs.** The Discord help, viewer profile/action and Stream Info
   modals have no `role="dialog"`, Escape handling or focus management. Write one shared
   `Modal`.
7. **Raw errors on the tablet.** OBS down shows `connect ECONNREFUSED 127.0.0.1:4455`
   beside "STUDIO OFF", which is not true while OBS is unreachable. Say "OBS offline" and
   hide the studio state.
8. **Empty and unavailable wording drifts.** The stat bar says `N/A`, `—` and "Twitch
   login required"; panels say "Unavailable" in italic; the tablet uses plain sentences.
   One `EmptyState` component (orb, italic title, sentence) would settle it.
9. **Attention list overflow gives no cue.** The last row is cut at the panel edge with
   no fade or count of what is below.
10. **Silent background refreshes.** The viewer roster poll (`ViewersPage`) and the
    `rewards:updated` refetch (`ViewerRewardsPage`) swallow errors, so a dead backend
    leaves a stale list with no marker.
11. **Settings headers have two paths.** `SettingsHeader` covers five sections; the
    other eight render their own. About 18 inline `style={{}}` remain, about 8 of them
    layout (`ConnectionsSection`, `GoLiveSection`, `shared.tsx` `SettingsRow`).
12. **Dead overlay-era CSS.** `styles.css`'s base `.chat-message` rules (4px stripe,
    8px radius, drop shadow, role stripe colours) are overridden everywhere they render:
    `ChatPanel` is only mounted with `compact`, and `.chat-panel.compact .chat-message`
    resets border, radius and shadow. Worth deleting in an overlay-side pass, not here.
