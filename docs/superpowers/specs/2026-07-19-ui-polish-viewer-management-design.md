# UI polish and viewer management — design

Date: 2026-07-19

Six requested changes. Every UI defect below was reproduced in a running browser
against a credential-stripped `VACUUM INTO` snapshot, not inferred from CSS.

## 1. Settings split-editor pages (Actions / Triggers / Modules)

Four defects, all rooted in these three pages hand-rolling a split-pane editor
instead of using the shared `SettingsRow` primitive.

**Dead sticky pane + clipped list.** `.set-group` sets `overflow: hidden`
(panel.css:909). It sits between the scroller (`.settings-canvas`) and the
sticky editor (`.settings-split-detail`), so it becomes the sticky element's
nearest scrollport — and it never scrolls (`scrollWidth === clientWidth`, 963/963
measured). The editor therefore scrolls away, contradicting its own design
comment. The same rule clips the action list horizontally, cutting the
`/ban <user> [reason]` usage chip mid-text and giving the list its own
horizontal scrollbar.

Fix: replace `overflow: hidden` with `overflow: clip` + `overflow-clip-margin`,
or move the clipping to the header/radius concern that needed it. The rule
exists to keep the group's rounded corners from being overdrawn by a child, so
the corner containment must be preserved.

**Neighbour reflow on a setting change.** `.action-step-body` uses
`align-items: end` (panel.css:2889) — the exact anti-pattern already diagnosed
and fixed for `.settings-mini-form`, which sets `align-items: start`
(panel.css:1166) with an explanatory comment. Measured: switching a `play_media`
step's Volume override from `asset` to `custom` grows that cell to 93px and
pushes the neighbouring "When several are picked" label from labelTop 486 to
519. This is the reported "doesn't scale correctly with their settings".

Fix: `align-items: start`.

**Module status badges render grey.** `.settings-item-main span` (0,1,1;
panel.css:1114) outranks `.module-status--active|degraded|live` (0,1,0;
panel.css:3076-3091). Measured: all four badges compute `color:
rgb(123,133,160)` despite correct green/orange/red borders and backgrounds. The
codebase already applies the required escape for
`.settings-item-main .media-asset-tag--global`; modules never got it.

Fix: raise `.module-status--*` to `.settings-item-main .module-status--*`.

**No measure cap.** `.settings-measure .command-settings-form { max-width:
1060px }` (panel.css:847) is the only cap, and these three pages use
`.settings-editor-section` instead, which has none. The Save row
(`.command-settings-actions`) is a sibling of `.settings-mini-form`, so it
right-aligns to the full pane while the fields stop at 880px. Width-dependent —
invisible below ~1000px of pane, visible on a wide monitor.

Fix: cap `.settings-editor-section` to match, so the Save button and the fields
it saves share an edge.

## 2. Categories search box

`StreamCategoriesPage` wraps the type-ahead in `.cats-add`; `StreamInfoModal`
wraps the identical widget in `.field`. All input chrome comes from the
descendant selector `.field input` (panel.css:1995) — there is no global
`input {}` rule — so the categories input falls back to browser defaults.
Measured: `background: rgb(255,255,255)`, `color: rgb(0,0,0)`,
`border: 1.6px inset`, `Arial 13.3px`. It is also 184px wide while its
`.suggestion-anchor` parent is 420px, so the dropdown is more than twice the
width of the input that opens it.

Fix: wrap in `.field` and drop `.cats-add-label` in favour of `.field > span`,
matching StreamInfoModal.

## 3. Overlay bounds toggle → Display panel

`OverlayPlaceholderToggle` (panels.tsx) renders inside `ControlsPanel`, which
the dashboard only mounts when `showControls = status.obsConnected`. The bounds
flag has nothing to do with OBS, so the toggle silently disappears whenever OBS
is down — the moment an operator is most likely to be repositioning sources.

Move it into `TweaksPanel` (the "Display" popup behind the nav grid icon). The
component owns its own REST seed and `overlay:placeholders` subscription, so
this is a pure move with no prop threading. It should adopt the existing
`useOverlayPlaceholders` hook, which additionally refetches on socket reconnect.

Decisions: move rather than mirror; "Mute sound/video commands" stays in Stream
Controls, being persisted operator state rather than a positioning aid.

## 4. Chat link hyperlinks

Linkification already works and is centralized: `parseLinkToken`
(chatText.ts) feeds `renderWords`, reached by every chat surface via
`renderContent`. Verified in-browser that `https://codeacula.com` renders as a
real anchor. The gap is the accept list — `LINK_PREFIX` matches only
`http://`, `https://`, and `www.`, so the schemeless `twitch.tv/foo` that chat
actually posts is rejected, with a test pinning that rejection.

Fix: accept schemeless hosts whose TLD is on a curated allowlist. A bare
`word.word` rule would linkify `Node.js`, `config.json`, `3.5`, and `U.S.`, so
the allowlist is the point, not an optimisation. Also fix the `^`-anchored
prefix test, which today fails outright on leading punctuation (`(https://x.com`)
while trailing punctuation is peeled correctly.

The scheme allowlist stays, so a `javascript:` href remains unreachable.

**AutoMod panel** renders held-message text raw. Held messages are
disproportionately phishing, so it gets link-*styled* but non-clickable text —
the operator can see it is a URL without being one click from it.

**Overlay** keeps its deliberate link neutralization (styles.css:227): a browser
source cannot be clicked, and schemeless matching makes far more of a message an
anchor.

## 5. Lurker identity backfill

`chatters` is `(login, first_seen_at, message_count)` — no Twitch user id, no
display name. Rows are created in exactly one place, `chat.ts` on a chat
message, so a lurker is never recorded. `GET /api/chatters` already calls Helix
Get Chatters and already receives `user_id` and display name; it discards both
and the dashboard uses the result only to light an `isLive` dot on rows that
already exist.

Fix, per the "check if we don't have their data and pull it" instruction — no
new polling loop:

- Widen `chatters` with `twitch_user_id`, `display_name`,
  `profile_image_url`, `account_created_at`, `last_seen_at`.
- `/api/chatters` persists unknown logins with `message_count = 0` and
  batch-fetches `/helix/users` (100 per call) only for rows missing profile
  data.
- Follow the `pagination.cursor` the route currently drops.

**The booby trap:** `hasSeenChatterBefore` (streamSession.ts) is
`select 1 from chatters where login = ?`, and drives the first-ever-chatter
highlight. Inserting lurkers would silently kill that highlight for every lurker
who later types. Verified that `hasSeenChatterBefore` is called (chat.ts:117)
*before* the `upsertChatter` (chat.ts:169), so re-keying it on
`message_count > 0` preserves today's behaviour exactly and needs no new column.

## 6. Validate/refresh and flush

**Refresh** — a viewer-detail action that re-queries Helix, persists display
name / avatar / account age, and flags the row when Twitch no longer returns the
account (renamed, deleted, or banned).

**Flush** — deletes the `chatters`, `viewer_profiles`, and `chat_messages` rows
and adds the login to a persistent ignore list. The ignore list is load-bearing,
not a nicety: a hard delete alone is self-healing-hostile, because the bot's next
message immediately recreates the row. Append-only `chat_events` is left intact,
so a flush is auditable and reversible.

**Own-bot bug, fixed alongside:** the loop guard at chat.ts:176 runs *after* the
`upsertChatter` at chat.ts:169, so Narya's own bot is recorded as an ordinary
viewer. It is the one bot the system can identify with certainty. Move the guard
above the upsert.

## Verification

`bun run typecheck`, `bun test`, `bun run build`, plus in-browser confirmation
of each visual fix against the isolated instance on :5174.
