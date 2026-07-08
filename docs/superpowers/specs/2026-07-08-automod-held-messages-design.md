# AutoMod Held Messages — Design Spec
**Date:** 2026-07-08

## Overview

Twitch's AutoMod can hold a chat message for moderator review before it ever reaches chat. Today this app has no visibility into that at all — the operator has to switch to Twitch's native moderation view to see and resolve held messages. This adds a live queue of held messages to the Dashboard and Tablet, with the ability to approve (allow) or deny them directly from the app.

Twitch does not expose a "list currently held messages" REST endpoint — the only way to learn about a hold is the `automod.message.hold` EventSub notification, and the only way to learn a hold was resolved (by this app, Twitch's native UI, or any other tool) is `automod.message.update`. This is not a design choice; it's the only mechanism Twitch provides, so the whole feature is EventSub-driven.

---

## 1. Twitch integration

### New OAuth scope
Add `moderator:manage:automod` to `REQUIRED_TWITCH_OAUTH_SCOPES` in `src/server/twitch/auth.ts`. This scope is required both for the two new EventSub subscriptions below and for the "Manage Held AutoMod Messages" Helix API used to allow/deny. Because this is a new scope not previously granted, existing installs need one Twitch reconnect after this ships (same "Reconnect Twitch to grant" flow already used for other missing-scope cases — see `twitchMissingScopes` in `StatBar`).

### New EventSub subscriptions
In `src/server/eventsub.ts`, add to `interactionSubs` (same tier as `channel.follow`, since losing these is a real functional gap, not just cosmetic):

```ts
['automod.message.hold', '2', { broadcaster_user_id: bid, moderator_user_id: bid }],
['automod.message.update', '2', { broadcaster_user_id: bid, moderator_user_id: bid }],
```

### New EventSub notification handlers
In `handleEventSubNotification`, add cases:

- **`automod.message.hold`**: payload includes `message_id`, `user_id`, `user_login`, `user_name`, `message.text`, `held_at`, `reason` (`"automod"` | `"blocked_term"`), and (when `reason === "automod"`) `automod.category` / `automod.level`. Call `recordAutomodHold(...)` (new `src/server/automod.ts`), then `broadcast('automod:held', hold)`.
- **`automod.message.update`**: payload includes `message_id`, `status` (`"Approved"` | `"Denied"` | `"Expired"`), `moderator_user_name`. Call `resolveAutomodHold(messageId, status, moderatorUserName)`, then `broadcast('automod:resolved', hold)`. This fires regardless of whether the resolution happened through this app or Twitch's own UI, so the queue self-corrects either way.

### New Helix API call
In `src/server/twitch/api.ts`, add `resolveAutomodMessage(state, messageId, action: 'ALLOW' | 'DENY')`, calling `POST /helix/moderation/automod/message` with `{ user_id: moderatorId, msg_id: messageId, action }`, using the existing `getTwitchActionCredentials` + scope-check pattern (scope: `moderator:manage:automod`).

---

## 2. Data model

New table in `src/server/db.ts`:

```sql
create table if not exists automod_holds (
  id text primary key,           -- Twitch message_id
  channel text not null,
  username text not null,
  display_name text not null,
  message text not null,
  category text,                 -- AutoMod category, null for blocked-term holds
  level integer,                 -- AutoMod severity level, null for blocked-term holds
  held_at text not null,
  resolved_at text,
  resolution text,               -- 'allowed' | 'denied' | 'expired' | null while pending
  resolved_by text               -- moderator display name, null while pending or on expiry
);
```

The append-only `chat_events` table gets two new `type` values, `automod.hold` and `automod.resolve`, reusing its existing generic shape (`id, type, channel, message_id, username, payload_json, occurred_at`) for the audit trail — no schema change needed there, matching the existing dual-layer pattern (`chat_events` raw log / `automod_holds` mutable projection, same relationship as `chat_events` / `chat_messages`).

---

## 3. Backend module & routes

New `src/server/automod.ts` (mirrors `sounds.ts`'s shape):
- `recordAutomodHold(hold)` — inserts into `automod_holds` + `chat_events`.
- `resolveAutomodHold(id, resolution, resolvedBy)` — updates the row **only if `resolved_at is null`**, so an EventSub echo of our own action, or a duplicate notification, is a no-op instead of clobbering the resolution.
- `getAutomodQueue()` — returns `{ pending, recentlyResolved }` (pending = `resolved_at is null`; recentlyResolved = resolved within the last 15 minutes, capped at 20 rows).
- `allowAutomodMessage(state, id)` / `denyAutomodMessage(state, id)` — call `resolveAutomodMessage` (Helix), then optimistically call `resolveAutomodHold` + `broadcast('automod:resolved', ...)` immediately, without waiting for the EventSub echo.

New routes in `src/server/routes.ts`:
- `GET /api/automod/queue`
- `POST /api/automod/:id/allow`
- `POST /api/automod/:id/deny`

New shared type in `src/shared/api.ts`:

```ts
export type AutomodHold = {
  id: string;
  channel: string;
  username: string;
  displayName: string;
  message: string;
  category: string | null;
  level: number | null;
  heldAt: string;
  resolvedAt: string | null;
  resolution: 'allowed' | 'denied' | 'expired' | null;
  resolvedBy: string | null;
};
```

---

## 4. Frontend

New `src/client/automod.ts` (mirrors `music.ts`: shared hook + components used from two different pages):

- `useAutomodQueue()` — fetches `GET /api/automod/queue` on mount; subscribes to `automod:held` (prepend to `pending`) and `automod:resolved` (move the matching item from `pending` to `recentlyResolved`, or update it in place if it's a resolution the item already knew about); exposes `{ pending, recentlyResolved, allow(id), deny(id) }`.
- `AutomodPanel` — full view: pending items (message, sender, category/level tag, Allow/Deny buttons) plus a small "recently resolved" list below (who resolved it, allow/deny/expired).
- `AutomodQuickActions` — compact view: pending items only, as cards with Allow/Deny buttons, no history.

### Dashboard wiring
`src/client/pages/Dashboard.tsx`'s right-side panel currently tabs between "Activity" and "Chatters". Add a third tab, "AutoMod", rendering `<AutomodPanel />` (self-contained via its own hook — no `PanelCtx` threading needed, same as how `MusicControls`/`MusicPanel` are used independently on different pages today).

Because a pending hold needs attention even when that tab isn't active, extend the `tabs` prop (currently `{ id, label }` in `src/client/ui/shell.tsx`) to accept an optional `badge?: number`, rendered as a small counter on the tab itself. The "AutoMod" tab passes `badge: pending.length`.

### Tablet wiring
`src/client/pages/Tablet.tsx` gets a new section (next to "Sounds") rendering `<AutomodQuickActions />`.

---

## 5. Error handling & edge cases

- Allow/deny network or Twitch-API failures show an inline error on that specific card (mirrors the tablet's existing `commandError` pattern) — one failed action doesn't block the rest of the queue.
- `resolveAutomodHold`'s `resolved_at is null` guard makes resolution idempotent regardless of source (our own action's echo, a duplicate EventSub delivery, or a moderator resolving it through Twitch's native UI).
- Missing `moderator:manage:automod` scope doesn't block other EventSub subscriptions — the existing `subscribeToAllEvents` loop already tolerates individual subscription failures and only warns.

---

## 6. Testing

Add cases to `src/server/eventsub.test.ts` following its existing pattern (direct calls to `handleEventSubNotification` with synthetic payloads, asserting on DB state) for `automod.message.hold` and `automod.message.update`, including the resolved-idempotency guard.

Manual verification: `bun run typecheck && bun run build`, then confirm in-browser that a held message appears live on both the Dashboard's AutoMod tab (with badge count) and the Tablet's quick-action card, and that Allow/Deny actually clears it from both surfaces.
