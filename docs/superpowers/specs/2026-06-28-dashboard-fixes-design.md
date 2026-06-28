# Dashboard Fixes — Design Spec
**Date:** 2026-06-28

## Overview

Five targeted fixes to the Narya streaming dashboard:
1. Activity feed event-type filter (chip toggles, persisted to localStorage)
2. Chatters `moderator:read:chatters` scope added to OAuth flow
3. Activity feed height capped to 5-row scrollable viewport when not popped out
4. Remove duplicate status row from stream controls panel
5. EventSub reconnection loop: root-cause fix + logging + halt-and-notify on failure

---

## 1. Activity Feed Filter

### Problem
Ad breaks fire as `kind: 'redeem'` with `actor: 'Twitch'`. There is no way to hide them without also hiding other redeems. The user wants to suppress ad break events by default while being able to reveal them quickly.

### DB migration
Existing `stream_events` rows for ad breaks are stored as `kind = 'redeem'` with `actor = 'Twitch'` and `detail LIKE 'ad break%'`. A one-time migration in `src/server/db.ts` updates these to `kind = 'ad_break'` so historical events are correctly filtered:

```sql
UPDATE stream_events
SET kind = 'ad_break'
WHERE kind = 'redeem' AND actor = 'Twitch' AND detail LIKE 'ad break%';
```

This runs on server startup alongside existing schema migrations. No rollback needed — it's idempotent (rows already migrated have `kind = 'ad_break'` and won't match the `WHERE` clause).

### Data model change
Add `'ad_break'` to `StreamEvent.kind` in `src/shared/api.ts`:

```ts
kind: 'raid' | 'gift' | 'sub' | 'cheer' | 'follow' | 'redeem' | 'ad_break';
```

In `src/server/eventsub.ts`, the `channel.ad_break.begin` handler currently emits:
```ts
emitStreamEvent('redeem', 'Twitch', `ad break · ${durationSecs}s`, 'info');
```
Change the kind argument to `'ad_break'`.

### UI
`EventFeed` in `src/client/ui/panels.tsx` gains a filter bar rendered above the event list. The bar shows one chip per event kind that has appeared in the current session's event list. Chips not yet seen are hidden (no empty chips on load).

Each chip is a toggle button. **Ad breaks default to hidden** (off). All other kinds default to visible (on). State is stored in `localStorage` under the key `eventFeedHiddenKinds` as a JSON array of hidden kind strings (e.g. `["ad_break"]`). This is read once on mount and written on each toggle.

`EVT_ICON` and `EVT_TONE_OVERRIDE` maps in `panels.tsx` gain entries for `'ad_break'`.

Chip labels:
| kind | label |
|------|-------|
| follow | Follows |
| sub | Subs |
| gift | Gifts |
| cheer | Cheers |
| raid | Raids |
| redeem | Redeems |
| ad_break | Ad Breaks |

### Behavior
- The event list renders only events whose kind is not in the hidden set.
- The filter bar is visible at all times when events exist, even in popout mode.
- Toggling a chip persists immediately.

---

## 2. Chatters Scope Fix

### Problem
`moderator:read:chatters` is absent from `REQUIRED_TWITCH_OAUTH_SCOPES` in `src/server/twitch/auth.ts`. The OAuth flow never requests it, so no cached or refreshed token carries the scope. The `/api/chatters` route calls `getTwitchActionCredentials(state, ['moderator:read:chatters'])` which always throws 403.

### Fix
Add `'moderator:read:chatters'` to the `REQUIRED_TWITCH_OAUTH_SCOPES` array in `src/server/twitch/auth.ts`.

### User action required
A token refresh does not add new scopes. After deploying this change, the user must disconnect Twitch (Settings → Twitch → Disconnect) and re-authorize to obtain a token that includes the new scope. No code change is needed to prompt for this — the existing "twitchMissingScopes" indicator in the StatBar will surface the missing scope automatically once the new required list is in place.

---

## 3. Activity Feed Height — Scrollable 5-Row Viewport

### Problem
The activity feed panel has no height constraint in the dashboard layout. The user wants to see only the 5 most recent events without scrolling; all events are accessible by scrolling within the panel.

### Fix
Add a CSS rule to `src/client/styles/panel.css` that constrains `.evt-list` height when it is inside the dashboard panel (not inside a popout window). Approximate row height is ~48px; 5 rows ≈ 240px. Use `max-height` with `overflow-y: auto` so the panel shrinks if there are fewer than 5 events.

Target selector: `.panel-body .evt-list` (dashboard context). The popout renders inside `.popwin-body`, so the constraint does not apply there without extra selector specificity.

No JavaScript changes needed — this is a pure CSS constraint.

---

## 4. Remove Status Row from Stream Controls

### Problem
`ControlsPanel` in `src/client/ui/panels.tsx` renders a "status" `ctrl-section` showing live/offline state and uptime. This duplicates the `StatBar` at the top of the dashboard.

### Fix
Delete the first `<div className="ctrl-section">` block (the one rendering `ctrl-label = "status"` and `ctrl-status`) from `ControlsPanel`'s JSX. The `status` prop is still needed for `prerollAvailable` logic and the `obsConnected` check for scene switching, so the prop signature is unchanged.

---

## 5. EventSub Reconnection Loop

### Root cause analysis
The log pattern — connect → session_welcome → subscriptions created → code 1006 → 10s wait → repeat — indicates Twitch is terminating the WebSocket session shortly after subscription requests are sent. Code 1006 (abnormal close, no close frame) means the remote side dropped the TCP connection.

Most likely cause: one or more subscription API calls fail with 4xx (e.g. `channel.channel_points_custom_reward_redemption.add` requires custom channel points to be configured; `channel.ad_break.begin` requires ad scheduling to be enabled). When Twitch sees failed subscriptions on a new session, it may terminate the session. There is currently no exponential backoff, so the server hammers Twitch every 10 seconds.

The existing `createEventSubSubscription` logs failures via `console.error` but the user's log excerpt did not include these lines — they are likely present in the full output.

### Changes to `src/server/eventsub.ts`

**1. `createEventSubSubscription` returns success/failure**

Change return type from `void` to `boolean`. Return `true` on HTTP 2xx, `false` otherwise. Add a success log line on 2xx so the console shows which subscriptions land.

**2. Categorize subscriptions as required vs optional**

Required (failure is counted, session is considered broken without them):
- `channel.follow`
- `channel.subscribe`
- `channel.subscription.gift`
- `channel.subscription.message`
- `channel.cheer`
- `channel.raid`
- `channel.chat.notification`

Optional (failure is logged but not counted; channel may not support them):
- `channel.channel_points_custom_reward_redemption.add`
- `channel.ad_break.begin`

**3. `subscribeToAllEvents` returns a success count**

After iterating, return the count of successful required subscriptions. If zero required subscriptions succeeded, return `false`.

**4. Halt and notify on total failure**

In the `session_welcome` handler (inside `connectEventSubSocket`), if `subscribeToAllEvents` returns `false`:
- Log a clear error: `"EventSub: all required subscriptions failed — re-authorize Twitch or check token scopes"`
- Set `state.eventSubError = 'subscription_failed'` on RuntimeState
- Close the WebSocket
- Do **not** schedule a reconnect

This prevents the tight reconnect loop. The user must take action (re-authorize) to clear the error and re-attempt.

**5. Expose error in dashboard status**

`src/server/dashboard/status.ts` already assembles `DashboardStatus`. Add `eventSubError: string | null` to the status response so the frontend can surface it.

Add `eventSubError: string | null` to `DashboardStatus` in `src/shared/api.ts`.

**6. Surface in the UI**

In `src/client/ui/shell.tsx`, the StatBar already shows `eventSubConnected`. When `eventSubConnected` is `false` and `eventSubError` is `'subscription_failed'`, render a small warning label ("EventSub: re-auth needed") next to the EventSub gauge instead of just showing it as "closed".

**7. Clear error on successful session**

On successful `session_welcome` + at least one required subscription, set `state.eventSubError = null`.

**8. Manual retry**

Add a `POST /api/eventsub/reconnect` route that calls `disconnectEventSub` then `connectEventSub`. This lets the user trigger a reconnect from the UI after fixing the auth issue, without restarting the server. The StatBar warning can include a small "retry" button that calls this endpoint.

---

## Files to change

| File | Change |
|------|--------|
| `src/shared/api.ts` | Add `'ad_break'` to `StreamEvent.kind`; add `eventSubError` to `DashboardStatus` |
| `src/server/db.ts` | One-time migration: backfill `stream_events` rows from `kind='redeem'` to `kind='ad_break'` where applicable |
| `src/server/eventsub.ts` | Subscription result logging, required/optional split, halt + notify on total failure, manual retry route |
| `src/server/runtime.ts` | Add `eventSubError: string | null` field |
| `src/server/twitch/auth.ts` | Add `moderator:read:chatters` to required scopes |
| `src/server/dashboard/status.ts` | Include `eventSubError` in status response |
| `src/client/ui/shell.tsx` | StatBar shows warning + retry button when `eventSubError` is set |
| `src/client/ui/panels.tsx` | Activity feed filter bar; remove status ctrl-section from ControlsPanel; ad_break icon/tone entries |
| `src/client/styles/panel.css` | 5-row height cap on `.panel-body .evt-list` |
