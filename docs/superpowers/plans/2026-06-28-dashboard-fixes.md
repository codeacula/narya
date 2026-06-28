# Dashboard Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix five dashboard issues: activity feed ad-break filtering, chatters scope, feed height cap, redundant status display, and EventSub reconnection loop.

**Architecture:** Backend changes (types, DB migration, EventSub logic, scope list) are done first since the frontend depends on them. Client changes follow in dependency order: shared types → server → client service → UI components → CSS.

**Tech Stack:** Bun + Express backend, React + TypeScript SPA, SQLite via bun:sqlite, WebSocket EventSub, localStorage for filter preferences.

## Global Constraints

- TypeScript strict mode; two-space indentation; match existing file style exactly.
- No test suite — validation is `bun run typecheck` (must pass) plus manual browser smoke-test.
- Client/server API contracts live in `src/shared/api.ts`; never duplicate them.
- CSS classes in camelCase for overlay/tablet styles, kebab-case in `panel.css`.
- Commits use short imperative hyphenated messages.

---

### Task 1: Add `ad_break` kind and `eventSubError` to shared types

**Files:**
- Modify: `src/shared/api.ts`

**Interfaces:**
- Produces: `StreamEvent.kind` includes `'ad_break'`; `DashboardStatus` includes `eventSubError: string | null` — referenced by all later tasks.

- [ ] **Step 1: Add `'ad_break'` to `StreamEvent.kind` and `eventSubError` to `DashboardStatus`**

In `src/shared/api.ts`, make two edits:

Change line 107:
```ts
  kind: 'raid' | 'gift' | 'sub' | 'cheer' | 'follow' | 'redeem';
```
to:
```ts
  kind: 'raid' | 'gift' | 'sub' | 'cheer' | 'follow' | 'redeem' | 'ad_break';
```

Add `eventSubError: string | null;` to `DashboardStatus` after the `eventSubConnected` field (around line 143):
```ts
  eventSubConnected: boolean;
  eventSubError: string | null;
```

- [ ] **Step 2: Typecheck**

```bash
bun run typecheck
```

Expected: errors about `eventSubError` missing from `EMPTY_STATUS` and `getDashboardStatusSnapshot` return — these are expected and will be fixed in later tasks. No other new errors.

- [ ] **Step 3: Commit**

```bash
git add src/shared/api.ts
git commit -m "feat: add ad_break event kind and eventSubError to shared types"
```

---

### Task 2: DB migration — backfill `stream_events` ad_break rows

**Files:**
- Modify: `src/server/db.ts`

**Interfaces:**
- Consumes: nothing
- Produces: existing `stream_events` rows where `kind='redeem' AND actor='Twitch' AND detail LIKE 'ad break%'` are updated to `kind='ad_break'`; idempotent on re-run.

- [ ] **Step 1: Add the migration at the bottom of `src/server/db.ts`**

Append after the last `addColumnIfMissing` line (after line 231):

```ts
// Backfill ad break events that were stored as 'redeem' before the ad_break kind existed.
db.exec(`
  UPDATE stream_events
  SET kind = 'ad_break'
  WHERE kind = 'redeem' AND actor = 'Twitch' AND detail LIKE 'ad break%'
`);
```

- [ ] **Step 2: Typecheck**

```bash
bun run typecheck
```

Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add src/server/db.ts
git commit -m "feat: backfill stream_events ad_break kind from legacy redeem rows"
```

---

### Task 3: EventSub server — logging, required/optional split, halt on failure, ad_break emit, reconnect route

**Files:**
- Modify: `src/server/runtime.ts`
- Modify: `src/server/eventsub.ts`
- Modify: `src/server/index.ts`

**Interfaces:**
- Consumes: `DashboardStatus.eventSubError` (Task 1)
- Produces: `state.eventSubError` field; `POST /api/eventsub/reconnect` route; `registerEventSubRoutes` export.

- [ ] **Step 1: Add `eventSubError` to `RuntimeState` in `src/server/runtime.ts`**

Add after `eventSubKeepaliveTimer` (around line 57):
```ts
  eventSubKeepaliveTimer: ReturnType<typeof setTimeout> | null = null;
  eventSubError: string | null = null;
```

- [ ] **Step 2: Replace `createEventSubSubscription` in `src/server/eventsub.ts` to return boolean and log success**

Replace the existing `createEventSubSubscription` function (lines 85–110) with:

```ts
async function createEventSubSubscription(
  clientId: string,
  userToken: string,
  sessionId: string,
  type: string,
  version: string,
  condition: Record<string, string>,
): Promise<boolean> {
  try {
    const res = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
      method: 'POST',
      headers: {
        'Client-Id': clientId,
        'Authorization': `Bearer ${userToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ type, version, condition, transport: { method: 'websocket', session_id: sessionId } }),
    });
    if (!res.ok) {
      const text = await res.text();
      console.error(`EventSub: failed to subscribe to ${type} (${res.status}):`, text);
      return false;
    }
    console.log(`EventSub: subscribed to ${type}`);
    return true;
  } catch (err) {
    console.error(`EventSub: error subscribing to ${type}:`, err);
    return false;
  }
}
```

- [ ] **Step 3: Replace `subscribeToAllEvents` to split required/optional and return boolean**

Replace the existing `subscribeToAllEvents` function (lines 112–128) with:

```ts
async function subscribeToAllEvents(clientId: string, userToken: string, sessionId: string, bid: string): Promise<boolean> {
  const requiredSubs: Array<[string, string, Record<string, string>]> = [
    ['channel.follow', '2', { broadcaster_user_id: bid, moderator_user_id: bid }],
    ['channel.subscribe', '1', { broadcaster_user_id: bid }],
    ['channel.subscription.gift', '1', { broadcaster_user_id: bid }],
    ['channel.subscription.message', '1', { broadcaster_user_id: bid }],
    ['channel.cheer', '1', { broadcaster_user_id: bid }],
    ['channel.raid', '1', { to_broadcaster_user_id: bid }],
    ['channel.chat.notification', '1', { broadcaster_user_id: bid, user_id: bid }],
  ];
  const optionalSubs: Array<[string, string, Record<string, string>]> = [
    ['channel.channel_points_custom_reward_redemption.add', '1', { broadcaster_user_id: bid }],
    ['channel.ad_break.begin', '1', { broadcaster_user_id: bid }],
  ];

  let successCount = 0;
  for (const [type, version, condition] of requiredSubs) {
    const ok = await createEventSubSubscription(clientId, userToken, sessionId, type, version, condition);
    if (ok) successCount++;
  }
  for (const [type, version, condition] of optionalSubs) {
    await createEventSubSubscription(clientId, userToken, sessionId, type, version, condition);
  }

  if (successCount === 0) {
    console.error('EventSub: all required subscriptions failed — re-authorize Twitch or check token scopes');
    return false;
  }

  console.log(`EventSub: ${successCount}/${requiredSubs.length} required subscriptions active`);
  return true;
}
```

- [ ] **Step 4: Update `channel.ad_break.begin` handler to emit `'ad_break'` kind and update `session_welcome` handler to halt on subscription failure**

In `handleEventSubNotification`, change the `channel.ad_break.begin` case (around line 64):
```ts
    case 'channel.ad_break.begin': {
      const durationSecs = event.duration_seconds as number;
      const startedAt = new Date(event.started_at as string);
      state.adBreakEndsAt = new Date(startedAt.getTime() + durationSecs * 1000).toISOString();
      state.twitchAdScheduleCache = null;
      emitStreamEvent('ad_break', 'Twitch', `ad break · ${durationSecs}s`, 'info');
      break;
    }
```

In the `session_welcome` message handler block inside `connectEventSubSocket` (around line 249), replace the entire `if (msgType === 'session_welcome')` block with:

```ts
    if (msgType === 'session_welcome') {
      const session = msg.payload.session!;
      state.eventSubConnected = true;
      state.eventSubKeepaliveMs = (session.keepalive_timeout_seconds + 10) * 1000;
      resetKeepaliveTimer(state);
      console.log(`EventSub: session ${session.id} established`);

      if (!reconnectUrl) {
        void (async () => {
          if (!state.broadcasterId) {
            state.broadcasterId = await fetchBroadcasterId(creds.clientId, creds.userToken);
          }
          if (state.broadcasterId) {
            const ok = await subscribeToAllEvents(creds.clientId, creds.userToken, session.id, state.broadcasterId);
            if (!ok) {
              state.eventSubError = 'subscription_failed';
              clearKeepaliveTimer(state);
              state.clearEventSubSocket();
              try { ws.close(); } catch { /* ignore */ }
              return;
            }
          } else {
            console.error(`EventSub: could not resolve broadcaster ID for "${config.twitchChannel}"`);
          }
          state.eventSubError = null;
        })();
      } else {
        state.eventSubError = null;
      }
    }
```

- [ ] **Step 5: Add `import type { Express }` to the top of `src/server/eventsub.ts` and add `registerEventSubRoutes` at the bottom**

At the very top of the file, add to the existing imports block:
```ts
import type { Express } from 'express';
```

Then append `registerEventSubRoutes` after the closing brace of `connectEventSubSocket` (after line 310):

```ts
export function registerEventSubRoutes(app: Express, state: RuntimeState) {
  app.post('/api/eventsub/reconnect', (_req, res) => {
    disconnectEventSub(state);
    void connectEventSub(state);
    res.json({ ok: true });
  });
}
```

- [ ] **Step 6: Register the route in `src/server/index.ts`**

Add the import alongside existing eventsub imports (line 7):
```ts
import { connectEventSub, disconnectEventSub, registerEventSubRoutes } from './eventsub';
```

Add the route registration after `registerChattersRoutes` (around line 34):
```ts
registerChattersRoutes(app, runtimeState);
registerEventSubRoutes(app, runtimeState);
```

- [ ] **Step 7: Typecheck**

```bash
bun run typecheck
```

Expected: errors about `eventSubError` missing from status snapshot return (fixed in Task 4) and `EMPTY_STATUS` (fixed in Task 7). No other new errors.

- [ ] **Step 8: Commit**

```bash
git add src/server/runtime.ts src/server/eventsub.ts src/server/index.ts
git commit -m "feat: eventsub halt-and-notify on subscription failure, emit ad_break kind"
```

---

### Task 4: Include `eventSubError` in dashboard status response

**Files:**
- Modify: `src/server/dashboard/status.ts`

**Interfaces:**
- Consumes: `state.eventSubError` (Task 3)
- Produces: `/api/dashboard/status` response includes `eventSubError`

- [ ] **Step 1: Add `eventSubError` to the return object of `getDashboardStatusSnapshot`**

In `src/server/dashboard/status.ts`, find the return object inside `getDashboardStatusSnapshot` (around line 305). Add `eventSubError` alongside `eventSubConnected`:

```ts
  return {
    channel: config.twitchChannel,
    chatConnection: twitchClient.readyState?.() ?? 'UNKNOWN',
    obsConnected: isObsConnected(),
    eventSubConnected: state.eventSubConnected,
    eventSubError: state.eventSubError,
    ...getTwitchAuthStatus(state),
    ...streamStatus,
    ...obsHealthStats,
    activeChatters: getActiveChatterCount(),
    sessionChatters: getSessionChatterCount(),
    knownChatters: getKnownChatterCount(),
    streamSessionId: activeStreamSession?.id ?? null,
    streamSessionStartedAt: activeStreamSession?.startedAt ?? null,
    adBreakEndsAt: state.adBreakEndsAt,
    ...adSchedule,
  };
```

- [ ] **Step 2: Typecheck**

```bash
bun run typecheck
```

Expected: the `DashboardStatus` mismatch error for `eventSubError` in `getDashboardStatusSnapshot` is now resolved. Remaining errors are `EMPTY_STATUS` in Dashboard.tsx (fixed in Task 7).

- [ ] **Step 3: Commit**

```bash
git add src/server/dashboard/status.ts
git commit -m "feat: include eventSubError in dashboard status response"
```

---

### Task 5: Add `moderator:read:chatters` to required Twitch OAuth scopes

**Files:**
- Modify: `src/server/twitch/auth.ts`

**Interfaces:**
- Consumes: nothing
- Produces: OAuth flow requests `moderator:read:chatters`; `twitchMissingScopes` will surface it if the current token lacks it.

- [ ] **Step 1: Add the scope to `REQUIRED_TWITCH_OAUTH_SCOPES`**

In `src/server/twitch/auth.ts`, add `'moderator:read:chatters'` to the array (around line 8):

```ts
export const REQUIRED_TWITCH_OAUTH_SCOPES = [
  'moderator:read:followers',
  'moderator:read:chatters',
  'channel:read:subscriptions',
  'bits:read',
  'channel:read:redemptions',
  'channel:read:ads',
  'channel:edit:commercial',
  'channel:manage:broadcast',
  'moderator:manage:banned_users',
  'moderator:manage:shoutouts',
  'user:read:chat',
  'user:write:chat',
  'user:manage:whispers',
] as const;
```

- [ ] **Step 2: Typecheck**

```bash
bun run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/server/twitch/auth.ts
git commit -m "feat: add moderator:read:chatters to required twitch oauth scopes"
```

> **Note:** After deploying, the user must disconnect Twitch (Settings → Twitch → Disconnect) and re-authorize. The missing scope will surface in the StatBar's `twitchMissingScopes` warning until then.

---

### Task 6: Add `reconnectEventSub` to client service

**Files:**
- Modify: `src/client/services/dashboard.ts`

**Interfaces:**
- Consumes: `POST /api/eventsub/reconnect` (Task 3)
- Produces: `reconnectEventSub()` function used by Dashboard.tsx (Task 7)

- [ ] **Step 1: Add the service function to `src/client/services/dashboard.ts`**

Append after `getChatters`:

```ts
export async function reconnectEventSub(): Promise<{ ok: boolean }> {
  return sendJson<{ ok: boolean }>('/api/eventsub/reconnect', 'POST');
}
```

- [ ] **Step 2: Typecheck**

```bash
bun run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/client/services/dashboard.ts
git commit -m "feat: add reconnectEventSub service function"
```

---

### Task 7: StatBar EventSub warning + retry, and wire `eventSubError` through Dashboard

**Files:**
- Modify: `src/client/ui/shell.tsx`
- Modify: `src/client/pages/Dashboard.tsx`

**Interfaces:**
- Consumes: `DashboardStatus.eventSubError` (Task 1), `reconnectEventSub` (Task 6)
- Produces: StatBar shows "error" label and a retry button when `eventSubError` is set and `!eventSubConnected`

- [ ] **Step 1: Add `eventSubError` and `onReconnectEventSub` props to `StatBar` in `src/client/ui/shell.tsx`**

In the `StatBar` prop type definition (around line 147), add:
```ts
  eventSubConnected: boolean;
  eventSubError: string | null;
  onReconnectEventSub: () => void;
```

In the `StatBar` function signature destructuring, add:
```ts
  eventSubConnected,
  eventSubError,
  onReconnectEventSub,
```

- [ ] **Step 2: Update the StatBar gauge sub-line to show error state and retry button**

Find the line (around line 339):
```tsx
        <div className="gauge-sub">{uptimeSourceLabel} · chat {chatConnection.toLowerCase()} · events {eventSubConnected ? 'open' : 'closed'}</div>
```

Replace with:
```tsx
        <div className="gauge-sub">
          {uptimeSourceLabel} · chat {chatConnection.toLowerCase()} · events {eventSubConnected ? 'open' : eventSubError ? 'error' : 'closed'}
          {eventSubError && !eventSubConnected && (
            <button
              className="eventsub-retry-btn"
              title="Re-authorize Twitch, then click to retry EventSub"
              onClick={onReconnectEventSub}
            >
              retry
            </button>
          )}
        </div>
```

- [ ] **Step 3: Fix `EMPTY_STATUS` and wire props in `src/client/pages/Dashboard.tsx`**

In `EMPTY_STATUS` (around line 52), `eventSubConnected: false` already exists — add `eventSubError: null` directly after it:
```ts
  eventSubConnected: false,
  eventSubError: null,
```

Add the import of `reconnectEventSub` alongside other service imports (around line 19):
```ts
import {
  disconnectTwitch,
  getViewers,
  getChatEntries,
  getChatEntriesBefore,
  getStreamEvents,
  getDashboardStatus,
  getObsStatus,
  getStreamInfo,
  updateStreamInfo,
  runPrerollAds,
  updateViewerProfile,
  runGoLive,
  switchObsScene,
  getChatters,
  reconnectEventSub,
} from '../services/dashboard';
```

Add the handler after `handleTwitchBotLogout` (around line 248):
```ts
  const handleReconnectEventSub = React.useCallback(() => {
    void reconnectEventSub()
      .then(() => getDashboardStatus())
      .then(setStatus)
      .catch((error: unknown) => {
        console.error('Failed to reconnect EventSub:', error);
      });
  }, []);
```

Pass the new props to `StatBar` (find the StatBar JSX around line 483 and add):
```tsx
        eventSubError={status.eventSubError}
        onReconnectEventSub={handleReconnectEventSub}
```

- [ ] **Step 4: Add CSS for the retry button in `src/client/styles/panel.css`**

Append at the end of the file:
```css
.eventsub-retry-btn {
  margin-left: 6px;
  padding: 0 5px;
  font-size: 10px;
  font-family: var(--font-mono);
  color: var(--warning-base);
  border: 1px solid var(--warning-border);
  border-radius: 3px;
  background: transparent;
  cursor: pointer;
  line-height: 16px;
}
.eventsub-retry-btn:hover { background: var(--warning-bg); }
```

- [ ] **Step 5: Typecheck**

```bash
bun run typecheck
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/client/ui/shell.tsx src/client/pages/Dashboard.tsx src/client/styles/panel.css
git commit -m "feat: statbar shows eventsub error state with retry button"
```

---

### Task 8: Remove duplicate status row from ControlsPanel

**Files:**
- Modify: `src/client/ui/panels.tsx`

**Interfaces:**
- Consumes: nothing new
- Produces: `ControlsPanel` no longer renders the live/offline status section

- [ ] **Step 1: Delete the status `ctrl-section` block from `ControlsPanel`**

In `src/client/ui/panels.tsx`, find and remove the following block inside `ControlsPanel`'s return (around line 731):

```tsx
      <div className="ctrl-section">
        <span className="ctrl-label">status</span>
        <span className={'ctrl-status' + (status.streamActive ? ' live' : '')}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: status.streamActive ? 'var(--success-base)' : 'var(--silver-600)', display: 'inline-block', flexShrink: 0, boxShadow: status.streamActive ? '0 0 6px rgba(127,200,163,0.6)' : 'none' }} />
          {status.streamActive
            ? (status.uptimeSeconds !== null ? formatUptime(status.uptimeSeconds) : 'live')
            : 'offline'}
        </span>
      </div>
```

The `status` prop and `formatUptime` function remain — they are still used by `prerollAvailable` logic.

- [ ] **Step 2: Typecheck**

```bash
bun run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/client/ui/panels.tsx
git commit -m "feat: remove redundant status row from stream controls panel"
```

---

### Task 9: Activity feed filter chips and `ad_break` icon

**Files:**
- Modify: `src/client/ui/panels.tsx`
- Modify: `src/client/styles/panel.css`

**Interfaces:**
- Consumes: `StreamEvent.kind` includes `'ad_break'` (Task 1)
- Produces: `EventFeed` renders filter chips; ad breaks hidden by default; filter persisted to localStorage

- [ ] **Step 1: Add `EVT_KIND_LABEL` map and `ad_break` icon entry in `src/client/ui/panels.tsx`**

After `EVT_TONE_OVERRIDE` (around line 655), add:

```ts
const EVT_KIND_LABEL: Record<string, string> = {
  follow: 'Follows',
  sub: 'Subs',
  gift: 'Gifts',
  cheer: 'Cheers',
  raid: 'Raids',
  redeem: 'Redeems',
  ad_break: 'Ad Breaks',
};
```

In `EVT_ICON`, add the `ad_break` entry:
```ts
const EVT_ICON: Record<string, string> = {
  follow: 'heart',
  sub: 'star',
  gift: 'gift',
  cheer: 'bits',
  raid: 'swords',
  redeem: 'star',
  ad_break: 'play',
};
```

- [ ] **Step 2: Add localStorage helpers above `EventFeed`**

Add after `EVT_KIND_LABEL` (before the `EventFeed` function):

```ts
const EVT_FILTER_KEY = 'eventFeedHiddenKinds';
const EVT_DEFAULT_HIDDEN = new Set(['ad_break']);

function loadHiddenKinds(): Set<string> {
  try {
    const raw = localStorage.getItem(EVT_FILTER_KEY);
    if (raw === null) return new Set(EVT_DEFAULT_HIDDEN);
    return new Set(JSON.parse(raw) as string[]);
  } catch {
    return new Set(EVT_DEFAULT_HIDDEN);
  }
}

function saveHiddenKinds(hidden: Set<string>): void {
  localStorage.setItem(EVT_FILTER_KEY, JSON.stringify([...hidden]));
}
```

- [ ] **Step 3: Replace the `EventFeed` function with the filtered version**

Replace the entire `EventFeed` function (lines 660–682) with:

```tsx
function EventFeed({ ctx }: { ctx: PanelCtx }) {
  const [hiddenKinds, setHiddenKinds] = React.useState<Set<string>>(() => loadHiddenKinds());

  const toggleKind = React.useCallback((kind: string) => {
    setHiddenKinds(prev => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      saveHiddenKinds(next);
      return next;
    });
  }, []);

  const knownKinds = React.useMemo(
    () => [...new Set(ctx.events.map(e => e.kind))],
    [ctx.events],
  );

  const visibleEvents = ctx.events.filter(e => !hiddenKinds.has(e.kind));

  return (
    <div className="evt-feed">
      {knownKinds.length > 0 && (
        <div className="evt-filters">
          {knownKinds.map(kind => (
            <button
              key={kind}
              className={'evt-filter-chip' + (hiddenKinds.has(kind) ? ' off' : '')}
              onClick={() => toggleKind(kind)}
            >
              {EVT_KIND_LABEL[kind] ?? kind}
            </button>
          ))}
        </div>
      )}
      <div className="evt-list">
        {visibleEvents.map((e) => {
          const tone = EVT_TONE_OVERRIDE[e.kind] ?? e.tone;
          return (
            <div className={'evt tone-' + tone} key={e.id}>
              <div className="evt-icon">
                <Icon name={EVT_ICON[e.kind] ?? 'star'} />
              </div>
              <div className="evt-body">
                <div className="evt-actor">
                  {e.actor} <span className="verb">{e.kind === 'follow' ? 'followed' : ''}</span>
                </div>
                {e.kind !== 'follow' && <div className="evt-detail">{e.detail}</div>}
              </div>
              <div className="evt-ago">{e.ago}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Add filter chip and feed container CSS to `src/client/styles/panel.css`**

Append after the `.eventsub-retry-btn` rules added in Task 7 (or at the end of the file):

```css
.evt-feed { display: flex; flex-direction: column; }
.evt-filters {
  display: flex; flex-wrap: wrap; gap: 4px;
  padding: 6px 10px; border-bottom: 1px solid var(--border-1);
}
.evt-filter-chip {
  padding: 2px 8px; border-radius: 10px; font-size: 11px; cursor: pointer;
  border: 1px solid var(--border-2); background: var(--bg-2); color: var(--fg-1);
  line-height: 18px;
}
.evt-filter-chip.off {
  background: transparent; color: var(--fg-3); border-color: var(--border-1);
  text-decoration: line-through;
}
.evt-filter-chip:hover { border-color: var(--fg-3); }
```

- [ ] **Step 5: Typecheck**

```bash
bun run typecheck
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/client/ui/panels.tsx src/client/styles/panel.css
git commit -m "feat: activity feed filter chips with ad_break hidden by default"
```

---

### Task 10: Activity feed height — scrollable 5-row viewport

**Files:**
- Modify: `src/client/styles/panel.css`

**Interfaces:**
- Consumes: `.evt-list` inside `.panel-body` (dashboard); `.evt-list` inside `.popwin-body` (popout, no constraint)
- Produces: the dashboard activity feed shows ~5 rows before scrolling; popout is unconstrained

- [ ] **Step 1: Add the height cap rule to `src/client/styles/panel.css`**

Each `.evt` row has 8px top padding + ~26px content + 8px bottom padding + 1px border = ~43px. Five rows ≈ 215px. Append:

```css
/* Cap the activity feed to ~5 rows in the dashboard panel; popout is unconstrained */
.panel-body .evt-list { max-height: 215px; overflow-y: auto; }
```

- [ ] **Step 2: Typecheck**

```bash
bun run typecheck
```

Expected: no errors (CSS changes don't affect TypeScript).

- [ ] **Step 3: Verify visually**

Start the dev server (`bun run dev`), open the dashboard, and confirm:
- Activity feed shows ~5 events before scrolling
- Scrolling within the panel reveals older events
- Popping out the activity feed removes the height constraint (scroll the whole window)
- Ad break events are not visible by default; toggling "Ad Breaks" chip shows them

- [ ] **Step 4: Commit**

```bash
git add src/client/styles/panel.css
git commit -m "feat: cap activity feed to 5-row scrollable viewport in dashboard"
```

---

## Post-implementation checklist

- [ ] Run `bun run typecheck` — must pass clean
- [ ] Run `bun run build` — must pass clean  
- [ ] Disconnect and re-authorize Twitch in Settings to pick up `moderator:read:chatters`
- [ ] Confirm chatters panel loads without the scope error
- [ ] Confirm EventSub console output shows per-subscription success lines, and stops retrying on failure
- [ ] Confirm StatBar shows "error" + "retry" button when EventSub subscriptions fail
- [ ] Confirm "Ad Breaks" filter chip hides ad break events by default
- [ ] Confirm toggling the chip shows/hides ad breaks and preference persists on refresh
- [ ] Confirm stream controls panel no longer shows live/offline status
- [ ] Confirm activity feed scrolls at 5 rows in dashboard; unconstrained in popout
