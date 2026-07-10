# Dashboard improvements — tablet fix, stream categories & tags, viewers management

**Date:** 2026-07-10
**Branch:** `redesign-tablet-and-statbar`
**Status:** Approved design, pending implementation plan

## Overview

Five requests, built sequentially on one branch (shared files make parallel worktrees
counter-productive). Four are buildable; one is a Twitch platform limitation.

| # | Request | Outcome |
|---|---------|---------|
| A | Tablet sound/clip buttons keep the gold highlight after a tap | Fix: clear focus highlight after tap |
| B | Manage stored stream categories; assign tags that auto-apply on switch | New Categories management page + per-category tag sets |
| C | Tag search only suggests what you type | Fix: local tag history feeds real autocomplete |
| D | Grant VIP/Moderator from the dashboard; a viewers section | New Viewers page + VIP/Mod endpoints |
| E | Toggle "Twitch-managed" rewards | **Not possible** — documented, left as-is |

B and C are one feature area (a category's tags are also the richest source of tag
suggestions), so they share a data model and page.

---

## Feature A — Tablet button focus highlight

**Problem.** `.tabletShell button:focus-visible` draws `outline: 2px solid var(--gold-400)`
(`src/client/styles.css:79`). On a touch screen the button keeps focus after the tap, and
mobile browsers apply `:focus-visible` heuristics that leave the gold outline stuck on
sound/clip buttons.

**Fix.** These are fire-and-forget buttons — nothing depends on them holding focus. In
`Tablet.tsx`, blur the button after firing (`event.currentTarget.blur()`) inside the sound
and clip `onClick` handlers. Scene/transition buttons already change appearance to reflect
state and can keep their focus behavior. Keyboard focus styling stays intact (blur only
fires on actual pointer activation of these two grids).

**Files:** `src/client/pages/Tablet.tsx`.
**Test:** unit coverage is awkward for focus; verify in-browser on the tablet route.

---

## Feature B + C — Stream categories management & auto-applied tags

### Data model

Two new tables (added to the `create table if not exists` block in `src/server/db.ts`,
following the existing pattern):

```sql
create table if not exists stream_category_tags (
  game_id text not null,
  tag text not null,
  created_at text not null,
  primary key (game_id, tag),
  foreign key (game_id) references stream_categories(game_id) on delete cascade
);

create table if not exists stream_tag_history (
  tag text primary key,      -- normalized (lowercase for key, display kept)
  display text not null,
  last_used_at text not null
);
```

`stream_category_tags` holds the tag set assigned to each saved category.
`stream_tag_history` is the autocomplete source — every tag ever saved via stream-info or
assigned to a category is recorded here, since Twitch no longer exposes a tag search API.

### Server: `src/server/streamCategories.ts` (extend)

New/extended endpoints:

- `GET /api/stream-categories` — extend each row with its assigned `tags: string[]` and the
  reward groups mapped to it (`rewardGroups: { id, name }[]`, reverse lookup of
  `viewer_reward_category_games`). This is the "see everything associated with them" data.
- `PUT /api/stream-categories/:gameId/tags` — replace a category's tag set. Body `{ tags }`,
  normalized via the existing `normalizeTags`/`normalizeTwitchTagCandidate` (max 10). Also
  upserts each tag into `stream_tag_history`.
- `DELETE /api/stream-categories/:gameId` — remove a saved category (cascades tags). The page
  needs real removal, not just hide.
- `GET /api/stream-tags?query=` — suggestions from `stream_tag_history` (substring match,
  most-recent first), used by the tag autocomplete everywhere.

### Server: tag history recording

In `PATCH /api/twitch/stream-info` (`src/server/twitch/api.ts`), after a successful Twitch
update, record the saved `tags` into `stream_tag_history`. This grows the suggestion pool
organically from real usage.

### Server: tag suggestions fix (Feature C)

Rewrite `GET /api/twitch/tag-suggestions` to merge, deduped and ranked:
1. `stream_tag_history` matches (the real fix),
2. current channel tags that match (existing behavior),
3. the normalized candidate the user typed (so a brand-new tag is always addable).

This keeps the endpoint's contract (`string[]`) so the client needs no change beyond
richer results.

### Client: category → tags auto-apply (replace)

In `StreamInfoModal.tsx`, when the user picks a category that has a saved tag set, replace
`form.tags` with that set (the approved "Replace" behavior). It happens client-side before
save, so the user sees the tags populate and can still tweak them before hitting Save. The
existing PATCH then sends those tags to Twitch as usual — no server-side surprise.

The modal fetches saved categories already (`getSavedStreamCategories`); it will use the
extended payload's `tags` field to know each category's set.

### Client: new Categories management page

- Route `categories` → path `/settings/categories`, added to `routing.ts`'s `DashboardRoute`
  union and `dashboardRouteFromPath`/`pathForDashboardRoute`.
- Rendered in `Dashboard.tsx` alongside `rewards`/`settings`; nav entry "stream categories"
  in `NavBar` (`shell.tsx`).
- `src/client/pages/StreamCategoriesPage.tsx`: lists saved categories (box art + name),
  each row showing:
  - an editable tag chip input with autocomplete from `GET /api/stream-tags`,
  - the reward groups linked to that category (read-only chips, from `rewardGroups`),
  - hide/unhide (existing) and remove actions.
- Service methods in `src/client/services/dashboard.ts`: `getStreamCategoryTags` folded into
  the existing `getSavedStreamCategories` payload, plus `setStreamCategoryTags`,
  `deleteStreamCategory`, `getTagSuggestionsFromHistory`.

### Shared contracts (`src/shared/api.ts`)

- Extend `SavedStreamCategory` with `tags: string[]` and `rewardGroups: { id: string; name: string }[]`.
- Add request/response types for the tag PUT and stream-tags GET as needed.

---

## Feature D — Viewers page & VIP/Moderator management

### New OAuth scopes (requires one reconnect)

Add to `REQUIRED_TWITCH_OAUTH_SCOPES` (`src/server/twitch/auth.ts`):
- `channel:manage:vips` (covers read + grant/remove VIP)
- `channel:manage:moderators` (covers read + grant/remove mod)

The dashboard already surfaces missing-scope prompts; the user clicks "Reconnect Twitch"
once to grant them. Actions gate on scope presence via the existing
`getTwitchActionCredentials(state, scopes)` path, which returns a clear 403 when missing.

### Server: `src/server/viewers.ts` (new module)

Reuses `resolveTwitchUserId`, `getTwitchActionCredentials`, and the error helpers already in
`twitch/api.ts` (export the couple of currently-private helpers it needs, or thread them
through). Endpoints:

- `GET /api/twitch/vips` → `GET /helix/channels/vips` (list current VIPs)
- `GET /api/twitch/moderators` → `GET /helix/moderation/moderators` (list current mods)
- `POST /api/twitch/users/:login/vip` / `DELETE …/vip` → `POST`/`DELETE /helix/channels/vips`
- `POST /api/twitch/users/:login/moderator` / `DELETE …/moderator` →
  `POST`/`DELETE /helix/moderation/moderators`

Twitch quirks handled: broadcaster can't be modded; a user must be un-VIP'd before being
modded and vice-versa (surface Twitch's 400/409/422 messages verbatim via `readResponseError`,
as the existing ban/timeout handlers do). Register the module in the route wiring.

### Client: new Viewers page

- Route `viewers` → path `/viewers`, wired through `routing.ts`, `Dashboard.tsx`, `NavBar`.
- `src/client/pages/ViewersPage.tsx`:
  - a username search box (resolve + act on anyone, in-chat or not),
  - a list of current chatters (`GET /api/chatters`, already available) with a role badge
    (VIP / Mod / none, cross-referenced from the vips/mods lists),
  - per-viewer actions: Grant/Remove VIP, Grant/Remove Mod, plus the existing Timeout, Ban,
    Shoutout, Whisper (reuse existing endpoints/service methods).
- Service methods in `dashboard.ts`: `getVips`, `getModerators`, `grantVip`, `removeVip`,
  `grantModerator`, `removeModerator`.

### Shared contracts

Add `ViewerRole`/list types (`{ userId, userLogin, userName }[]` for vips & mods) to
`src/shared/api.ts`.

---

## Feature E — "Twitch-managed" rewards: no change

Twitch's Channel Points API only lets an application edit/enable/disable/delete rewards that
the **same client ID created**. Rewards created by another app (the user's rewards mod) are
returned by `only_manageable_rewards=false` but are read-only to our token — exactly what the
`canManage` flag and the "Twitch-managed" badge already convey. There is no API workaround.
Per the approved decision, the rewards page is left exactly as-is.

---

## Build sequence

1. **A** — tablet focus fix (isolated, fast). Commit.
2. **C+B server** — DB tables, tag history recording, tag-suggestions rewrite, stream-category
   tag/list/delete endpoints, shared types. Commit.
3. **B client** — Categories page + nav/routing + modal auto-apply. Commit.
4. **D server** — scopes, viewers module + endpoints, shared types. Commit.
5. **D client** — Viewers page + nav/routing. Commit.

Each step: `bun run typecheck`, `bun test`, `bun run build`, and in-browser check before the
commit. Colocated `*.test.ts` for the new server modules (tag normalization/history, category
tag replace, viewers endpoint request shaping via mocked fetch).

## Out of scope

- Recreating/cloning Twitch-managed rewards (declined).
- Server-side auto-apply of tags on category changes made outside this app (Twitch has no
  webhook for "streamer changed game via the Twitch UI"; the app applies tags through its own
  Stream Info save only).
- Bulk VIP/mod operations, ban lists, or a full viewer CRM.

## Verification commands

```sh
bun run typecheck
bun test
bun run build
# in-browser: /tablet (A), /settings/categories (B/C), Stream Info modal (B), /viewers (D)
```
