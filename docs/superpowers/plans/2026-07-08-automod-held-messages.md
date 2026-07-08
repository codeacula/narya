# AutoMod Held Messages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the operator a live queue of Twitch AutoMod-held messages on both the Dashboard and Tablet, with the ability to allow or deny each one without leaving the app.

**Architecture:** Two new EventSub subscriptions (`automod.message.hold` / `automod.message.update`, v2) feed a new `automod_holds` table via a new `src/server/automod.ts` module, which also exposes REST endpoints and broadcasts WebSocket events. The client mirrors the existing `music.tsx` pattern: one shared hook (`useAutomodQueue`) backing two presentational surfaces — a Dashboard tab and a Tablet quick-action card.

**Tech Stack:** Bun/Express backend, bun:sqlite, Twitch EventSub (WebSocket transport) + Helix REST, React/TypeScript frontend, `bun test`.

## Global Constraints

- Full spec: `docs/superpowers/specs/2026-07-08-automod-held-messages-design.md`.
- New OAuth scope `moderator:manage:automod` is required — after this ships, Twitch must be reconnected once from Settings (existing "Reconnect Twitch to grant" flow handles this; no new UI needed).
- `resolveAutomodHold` must be idempotent (`resolved_at is null` guard) so our own optimistic resolution and the later EventSub echo of the same action don't double-apply.
- Follow existing two-space indentation, TypeScript strict mode, no new linter/formatter.
- Client automod widgets use the `music.tsx` convention: camelCase classNames styled in `src/client/styles.css` (NOT panel.css's kebab-case), because the components are shared across the Dashboard and Tablet, exactly like `MusicPanel`/`MusicControls`.
- Every task ends with `bun run typecheck` passing. Server-side tasks also run `bun test`.

---

### Task 1: Data model — `automod_holds` table, shared type, `src/server/automod.ts`

**Files:**
- Modify: `src/server/db.ts` (add table + index)
- Modify: `src/shared/api.ts` (add `AutomodHold` type)
- Modify: `src/server/chat.ts` (export the existing `appendChatEvent` helper)
- Create: `src/server/automod.ts`
- Create: `src/server/automod.test.ts`

**Interfaces:**
- Consumes: `appendChatEvent(type, channel, payload, options?)` from `./chat` (already exists, just needs to become exported) — reused for the `chat_events` audit trail per the spec's dual-layer pattern.
- Produces: `AutomodHold` type (shared/api.ts), `recordAutomodHold(hold): AutomodHold`, `resolveAutomodHold(id, resolution, resolvedBy): AutomodHold | null`, `getAutomodQueue(): { pending: AutomodHold[]; recentlyResolved: AutomodHold[] }` — all exported from `src/server/automod.ts`. Later tasks (2, 3) import these.

- [ ] **Step 1: Add the `automod_holds` table and index to `src/server/db.ts`**

In `src/server/db.ts`, add this table definition immediately after the `app_config` table (right before the closing `` `); `` that ends the first `db.exec(...)` block, i.e. right before line 230 `` `); ``):

```sql
  create table if not exists automod_holds (
    id text primary key,
    channel text not null,
    username text not null,
    display_name text not null,
    message text not null,
    category text,
    level integer,
    held_at text not null,
    resolved_at text,
    resolution text,
    resolved_by text
  );
```

Then add an index in the second `db.exec(...)` block, immediately after the existing `idx_viewer_reward_category_games_category` line (right before its closing `` `); ``):

```sql
  create index if not exists idx_automod_holds_resolved_at on automod_holds(resolved_at);
```

- [ ] **Step 2: Add the `AutomodHold` type to `src/shared/api.ts`**

Add near `ChatModerationEvent` (after its closing `};`):

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

- [ ] **Step 3: Write the failing test for `src/server/automod.ts`**

Create `src/server/automod.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import {
  getAutomodQueue,
  recordAutomodHold,
  resolveAutomodHold,
} from './automod';

function sampleHold(overrides: Partial<Parameters<typeof recordAutomodHold>[0]> = {}) {
  const id = `hold-${crypto.randomUUID()}`;
  return {
    id,
    channel: 'codeacula',
    username: 'testviewer',
    displayName: 'TestViewer',
    message: 'this message was held',
    category: 'profanity',
    level: 2,
    heldAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('recordAutomodHold', () => {
  test('inserts a pending hold that shows up in the queue', () => {
    const hold = sampleHold();
    const recorded = recordAutomodHold(hold);
    expect(recorded.id).toBe(hold.id);
    expect(recorded.resolvedAt).toBeNull();
    expect(recorded.resolution).toBeNull();

    const queue = getAutomodQueue();
    expect(queue.pending.some(h => h.id === hold.id)).toBe(true);
  });
});

describe('resolveAutomodHold', () => {
  test('marks a pending hold as resolved and moves it out of pending', () => {
    const hold = sampleHold();
    recordAutomodHold(hold);

    const resolved = resolveAutomodHold(hold.id, 'allowed', 'You');
    expect(resolved?.resolution).toBe('allowed');
    expect(resolved?.resolvedBy).toBe('You');
    expect(resolved?.resolvedAt).not.toBeNull();

    const queue = getAutomodQueue();
    expect(queue.pending.some(h => h.id === hold.id)).toBe(false);
    expect(queue.recentlyResolved.some(h => h.id === hold.id)).toBe(true);
  });

  test('is idempotent — a second resolve call does not overwrite the first', () => {
    const hold = sampleHold();
    recordAutomodHold(hold);

    resolveAutomodHold(hold.id, 'allowed', 'You');
    const secondAttempt = resolveAutomodHold(hold.id, 'denied', 'AutoMod');

    // The row itself is still 'allowed' by 'You' — the second call was a no-op.
    expect(secondAttempt?.resolution).toBe('allowed');
    expect(secondAttempt?.resolvedBy).toBe('You');
  });

  test('resolving an unknown id returns null', () => {
    const result = resolveAutomodHold(`missing-${crypto.randomUUID()}`, 'denied', null);
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `bun test src/server/automod.test.ts`
Expected: FAIL — `Cannot find module './automod'` (the module doesn't exist yet).

- [ ] **Step 5: Export `appendChatEvent` from `src/server/chat.ts`**

In `src/server/chat.ts`, add `export` to the existing function declaration (it's currently private):

```ts
export function appendChatEvent(
```

No other change to that function — it already writes to `chat_events` with the exact generic shape (`id, type, channel, message_id, username, payload_json, occurred_at`) this task needs for the AutoMod audit trail.

- [ ] **Step 6: Implement `src/server/automod.ts`**

```ts
import type { AutomodHold } from '../shared/api';
import { appendChatEvent } from './chat';
import { db } from './db';
import { broadcast } from './realtime';

const RESOLVED_HISTORY_WINDOW_MS = 15 * 60 * 1000;
const RESOLVED_HISTORY_LIMIT = 20;

const insertAutomodHold = db.prepare(`
  insert or ignore into automod_holds
    (id, channel, username, display_name, message, category, level, held_at, resolved_at, resolution, resolved_by)
  values
    (?, ?, ?, ?, ?, ?, ?, ?, null, null, null)
`);

const resolveAutomodHoldRow = db.prepare(`
  update automod_holds
  set resolved_at = ?, resolution = ?, resolved_by = ?
  where id = ? and resolved_at is null
`);

const getAutomodHoldRow = db.prepare(`
  select
    id, channel, username,
    display_name as displayName,
    message, category, level,
    held_at as heldAt,
    resolved_at as resolvedAt,
    resolution,
    resolved_by as resolvedBy
  from automod_holds
  where id = ?
`);

const listPendingAutomodHolds = db.prepare(`
  select
    id, channel, username,
    display_name as displayName,
    message, category, level,
    held_at as heldAt,
    resolved_at as resolvedAt,
    resolution,
    resolved_by as resolvedBy
  from automod_holds
  where resolved_at is null
  order by held_at asc
`);

const listRecentlyResolvedAutomodHolds = db.prepare(`
  select
    id, channel, username,
    display_name as displayName,
    message, category, level,
    held_at as heldAt,
    resolved_at as resolvedAt,
    resolution,
    resolved_by as resolvedBy
  from automod_holds
  where resolved_at is not null and resolved_at >= ?
  order by resolved_at desc
  limit ?
`);

export function recordAutomodHold(hold: {
  id: string;
  channel: string;
  username: string;
  displayName: string;
  message: string;
  category: string | null;
  level: number | null;
  heldAt: string;
}): AutomodHold {
  insertAutomodHold.run(
    hold.id,
    hold.channel,
    hold.username,
    hold.displayName,
    hold.message,
    hold.category,
    hold.level,
    hold.heldAt,
  );
  appendChatEvent('automod.hold', hold.channel, hold, {
    messageId: hold.id,
    username: hold.username,
    occurredAt: hold.heldAt,
  });
  const row = getAutomodHoldRow.get(hold.id) as AutomodHold;
  broadcast('automod:held', row);
  return row;
}

export function resolveAutomodHold(
  id: string,
  resolution: 'allowed' | 'denied' | 'expired',
  resolvedBy: string | null,
): AutomodHold | null {
  const resolvedAt = new Date().toISOString();
  const result = resolveAutomodHoldRow.run(resolvedAt, resolution, resolvedBy, id) as { changes: number };
  const row = getAutomodHoldRow.get(id) as AutomodHold | null;
  if (result.changes > 0 && row) {
    appendChatEvent('automod.resolve', row.channel, { resolution, resolvedBy }, {
      messageId: id,
      username: row.username,
      occurredAt: resolvedAt,
    });
    broadcast('automod:resolved', row);
  }
  return row;
}

export function getAutomodQueue(): { pending: AutomodHold[]; recentlyResolved: AutomodHold[] } {
  const since = new Date(Date.now() - RESOLVED_HISTORY_WINDOW_MS).toISOString();
  return {
    pending: listPendingAutomodHolds.all() as AutomodHold[],
    recentlyResolved: listRecentlyResolvedAutomodHolds.all(since, RESOLVED_HISTORY_LIMIT) as AutomodHold[],
  };
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `bun test src/server/automod.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 8: Typecheck**

Run: `bun run typecheck`
Expected: no errors

- [ ] **Step 9: Commit**

```bash
git add src/server/db.ts src/shared/api.ts src/server/chat.ts src/server/automod.ts src/server/automod.test.ts
git commit -m "feat: add AutoMod held-message data model"
```

---

### Task 2: Twitch EventSub — scope, subscriptions, notification handlers

**Files:**
- Modify: `src/server/twitch/auth.ts:9-24` (add scope)
- Modify: `src/server/eventsub.ts` (subscriptions + handler cases)
- Modify: `src/server/eventsub.test.ts` (new test cases)

**Interfaces:**
- Consumes: `recordAutomodHold`, `resolveAutomodHold` from Task 1 (`./automod`).
- Produces: nothing new consumed by later tasks — this task's payoff is fully-wired live data flow, verified end-to-end in Task 6.

- [ ] **Step 1: Add the new scope**

In `src/server/twitch/auth.ts`, add `'moderator:manage:automod',` to `REQUIRED_TWITCH_OAUTH_SCOPES` (after `'moderator:manage:banned_users',` on line 18):

```ts
export const REQUIRED_TWITCH_OAUTH_SCOPES = [
  'moderator:read:followers',
  'moderator:read:chatters',
  'channel:read:subscriptions',
  'bits:read',
  'channel:manage:redemptions',
  'channel:read:ads',
  'channel:edit:commercial',
  'channel:manage:broadcast',
  'moderator:manage:banned_users',
  'moderator:manage:automod',
  'moderator:manage:shoutouts',
  'user:read:chat',
  'user:write:chat',
  'user:manage:whispers',
  'user:read:whispers',
] as const;
```

- [ ] **Step 2: Write the failing tests in `src/server/eventsub.test.ts`**

Add these two `describe` blocks after the existing `stream.offline` test (before the closing `});` of the outer `describe('handleEventSubNotification', ...)`):

```ts
  test('automod.message.hold records a pending held message', async () => {
    const messageId = `msg-${crypto.randomUUID()}`;
    await handleEventSubNotification(new RuntimeState(), 'automod.message.hold', {
      message_id: messageId,
      broadcaster_user_login: 'codeacula',
      user_login: 'testviewer',
      user_name: 'TestViewer',
      message: { text: 'this is a held message' },
      held_at: '2026-07-08T12:00:00.000Z',
      reason: 'automod',
      automod: { category: 'profanity', level: 2 },
    });
    const queue = getAutomodQueue();
    const held = queue.pending.find(h => h.id === messageId);
    expect(held).toMatchObject({
      username: 'testviewer',
      displayName: 'TestViewer',
      message: 'this is a held message',
      category: 'profanity',
      level: 2,
      resolution: null,
    });
  });

  test('automod.message.update resolves a held message', async () => {
    const messageId = `msg-${crypto.randomUUID()}`;
    await handleEventSubNotification(new RuntimeState(), 'automod.message.hold', {
      message_id: messageId,
      user_login: 'testviewer',
      user_name: 'TestViewer',
      message: { text: 'another held message' },
      held_at: '2026-07-08T12:00:00.000Z',
      reason: 'automod',
      automod: { category: 'profanity', level: 1 },
    });
    await handleEventSubNotification(new RuntimeState(), 'automod.message.update', {
      message_id: messageId,
      status: 'Approved',
      moderator_user_name: 'SomeMod',
    });
    const queue = getAutomodQueue();
    expect(queue.pending.some(h => h.id === messageId)).toBe(false);
    const resolved = queue.recentlyResolved.find(h => h.id === messageId);
    expect(resolved).toMatchObject({ resolution: 'allowed', resolvedBy: 'SomeMod' });
  });
```

Add the import at the top of the file:

```ts
import { getAutomodQueue } from './automod';
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test src/server/eventsub.test.ts`
Expected: FAIL with something like "Unhandled case" / the queue not containing the expected row, since `handleEventSubNotification` doesn't have these cases yet.

- [ ] **Step 4: Add the EventSub subscriptions**

In `src/server/eventsub.ts`, add to `interactionSubs` in `subscribeToAllEvents` (after the `'channel.chat.notification'` line):

```ts
    ['automod.message.hold', '2', { broadcaster_user_id: bid, moderator_user_id: bid }],
    ['automod.message.update', '2', { broadcaster_user_id: bid, moderator_user_id: bid }],
```

- [ ] **Step 5: Add the notification handler cases**

In `src/server/eventsub.ts`, add the import:

```ts
import { recordAutomodHold, resolveAutomodHold } from './automod';
```

Add these two cases to the `switch (type)` in `handleEventSubNotification`, after the `'user.whisper.message'` case and before the closing `}`:

```ts
    case 'automod.message.hold': {
      const message = event.message as { text: string } | undefined;
      const automod = event.automod as { category?: string; level?: number } | undefined;
      recordAutomodHold({
        id: event.message_id as string,
        channel: (event.broadcaster_user_login as string) ?? appConfig.twitchChannel,
        username: (event.user_login as string) ?? 'unknown',
        displayName: (event.user_name as string) ?? (event.user_login as string) ?? 'unknown',
        message: message?.text ?? '',
        category: automod?.category ?? null,
        level: automod?.level ?? null,
        heldAt: (event.held_at as string) ?? new Date().toISOString(),
      });
      break;
    }
    case 'automod.message.update': {
      const status = event.status as string;
      const resolution = status === 'Approved' ? 'allowed' : status === 'Denied' ? 'denied' : 'expired';
      resolveAutomodHold(
        event.message_id as string,
        resolution,
        (event.moderator_user_name as string) ?? null,
      );
      break;
    }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun test src/server/eventsub.test.ts`
Expected: PASS (all tests including the two new ones)

- [ ] **Step 7: Typecheck**

Run: `bun run typecheck`
Expected: no errors

- [ ] **Step 8: Commit**

```bash
git add src/server/twitch/auth.ts src/server/eventsub.ts src/server/eventsub.test.ts
git commit -m "feat: subscribe to AutoMod hold/update EventSub notifications"
```

---

### Task 3: Twitch Helix action + REST routes

**Files:**
- Modify: `src/server/twitch/api.ts` (new `resolveAutomodMessage` function)
- Modify: `src/server/routes.ts` (new routes)

**Interfaces:**
- Consumes: `getAutomodQueue`, `resolveAutomodHold` (Task 1, `./automod`), `getTwitchActionCredentials` + private `getAuthenticatedActionUserId` (already in `twitch/api.ts`).
- Produces: `resolveAutomodMessage(state, messageId, action): Promise<void>` from `twitch/api.ts`; `GET /api/automod/queue`, `POST /api/automod/:id/allow`, `POST /api/automod/:id/deny` routes, consumed by Task 4's client service functions.

No unit test for this task: the codebase's existing convention is that raw Twitch Helix `fetch()` wrappers (e.g. `moderateTwitchUser`, `runTwitchCommercial`) are not unit-tested — there's no `twitch/api.test.ts` today. This task is verified by typecheck plus the full manual pass in Task 6.

- [ ] **Step 1: Add `resolveAutomodMessage` to `src/server/twitch/api.ts`**

Add this function after `moderateTwitchUser` (after its closing `}`, before `normalizeUserActionReason`):

```ts
export async function resolveAutomodMessage(
  state: RuntimeState,
  messageId: string,
  action: 'ALLOW' | 'DENY',
): Promise<void> {
  const credentials = await getTwitchActionCredentials(state, ['moderator:manage:automod']);
  const moderatorId = await getAuthenticatedActionUserId(state, credentials);

  const res = await fetch('https://api.twitch.tv/helix/moderation/automod/message', {
    method: 'POST',
    headers: {
      'Client-Id': credentials.clientId,
      Authorization: credentials.authorization,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ user_id: moderatorId, msg_id: messageId, action }),
  });
  if (!res.ok) {
    const errorMessage = await readResponseError(res, `Twitch AutoMod ${action.toLowerCase()} failed.`);
    throw new HttpRouteError(res.status === 401 || res.status === 403 ? res.status : 502, errorMessage);
  }
}
```

- [ ] **Step 2: Add the routes to `src/server/routes.ts`**

Add the import (alongside the other `./sounds` style imports near the top of the file):

```ts
import { getAutomodQueue, resolveAutomodHold } from './automod';
import { resolveAutomodMessage } from './twitch/api';
```

Add the routes inside `registerCoreRoutes`, after the `/api/sounds/:id/play` route block:

```ts
  app.get('/api/automod/queue', (_request, response) => {
    response.json(getAutomodQueue());
  });

  app.post('/api/automod/:id/allow', async (request, response) => {
    try {
      await resolveAutomodMessage(state, request.params.id, 'ALLOW');
      response.json(resolveAutomodHold(request.params.id, 'allowed', 'You'));
    } catch (error) {
      sendRouteError(response, error);
    }
  });

  app.post('/api/automod/:id/deny', async (request, response) => {
    try {
      await resolveAutomodMessage(state, request.params.id, 'DENY');
      response.json(resolveAutomodHold(request.params.id, 'denied', 'You'));
    } catch (error) {
      sendRouteError(response, error);
    }
  });
```

`sendRouteError` is already imported in `routes.ts` from `./http`.

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add src/server/twitch/api.ts src/server/routes.ts
git commit -m "feat: add AutoMod allow/deny API and REST routes"
```

---

### Task 4: Client hook + `AutomodPanel` / `AutomodQuickActions` components

**Files:**
- Modify: `src/client/services/dashboard.ts` (new service functions + type import)
- Create: `src/client/automod.tsx`
- Modify: `src/client/styles.css` (new styles)

**Interfaces:**
- Consumes: `AutomodHold` (shared/api.ts, Task 1), `useSocket` (`./realtime`), REST endpoints from Task 3.
- Produces: `useAutomodQueue()` hook returning `{ pending: AutomodHold[]; recentlyResolved: AutomodHold[]; allow(id): Promise<AutomodHold>; deny(id): Promise<AutomodHold> }`, `AutomodPanel` component, `AutomodQuickActions` component — all from `src/client/automod.tsx`. Consumed by Tasks 5 and 6.

- [ ] **Step 1: Add service functions to `src/client/services/dashboard.ts`**

Add `AutomodHold` to the type import block (after `SoundPlayback,`):

```ts
  SoundPlayback,
  AutomodHold,
```

Add these functions after `playSoundButton`:

```ts
export async function getAutomodQueue(): Promise<{ pending: AutomodHold[]; recentlyResolved: AutomodHold[] }> {
  return fetchJson('/api/automod/queue');
}

export async function allowAutomodHold(id: string): Promise<AutomodHold> {
  return sendJson<AutomodHold>(`/api/automod/${encodeURIComponent(id)}/allow`, 'POST');
}

export async function denyAutomodHold(id: string): Promise<AutomodHold> {
  return sendJson<AutomodHold>(`/api/automod/${encodeURIComponent(id)}/deny`, 'POST');
}
```

- [ ] **Step 2: Create `src/client/automod.tsx`**

```tsx
import React from 'react';
import type { AutomodHold } from '../shared/api';
import { useSocket } from './realtime';
import { allowAutomodHold, denyAutomodHold, getAutomodQueue } from './services/dashboard';

export function useAutomodQueue() {
  const [pending, setPending] = React.useState<AutomodHold[]>([]);
  const [recentlyResolved, setRecentlyResolved] = React.useState<AutomodHold[]>([]);

  React.useEffect(() => {
    getAutomodQueue()
      .then(queue => {
        setPending(queue.pending);
        setRecentlyResolved(queue.recentlyResolved);
      })
      .catch((error: unknown) => {
        console.error('Failed to load AutoMod queue:', error);
      });
  }, []);

  useSocket<AutomodHold>(
    'automod:held',
    React.useCallback((hold) => {
      setPending(current => (current.some(h => h.id === hold.id) ? current : [...current, hold]));
    }, []),
  );

  useSocket<AutomodHold>(
    'automod:resolved',
    React.useCallback((hold) => {
      setPending(current => current.filter(h => h.id !== hold.id));
      setRecentlyResolved(current => [hold, ...current.filter(h => h.id !== hold.id)].slice(0, 20));
    }, []),
  );

  const allow = React.useCallback((id: string) => allowAutomodHold(id), []);
  const deny = React.useCallback((id: string) => denyAutomodHold(id), []);

  return { pending, recentlyResolved, allow, deny };
}

function AutomodItem({
  hold,
  onAllow,
  onDeny,
}: {
  hold: AutomodHold;
  onAllow: (id: string) => Promise<AutomodHold>;
  onDeny: (id: string) => Promise<AutomodHold>;
}) {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function act(action: (id: string) => Promise<AutomodHold>) {
    setBusy(true);
    setError(null);
    try {
      await action(hold.id);
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : 'Action failed');
      setBusy(false);
    }
  }

  return (
    <article className="automodItem">
      <div className="automodItemHead">
        <strong>{hold.displayName}</strong>
        {hold.category ? <span className="automodTag">{hold.category} · L{hold.level}</span> : null}
      </div>
      <p className="automodMessage">{hold.message}</p>
      {error ? <p className="automodError">{error}</p> : null}
      <div className="automodItemActions">
        <button className="accent" disabled={busy} onClick={() => void act(onAllow)}>Allow</button>
        <button className="dangerButton" disabled={busy} onClick={() => void act(onDeny)}>Deny</button>
      </div>
    </article>
  );
}

export function AutomodPanel() {
  const { pending, recentlyResolved, allow, deny } = useAutomodQueue();

  return (
    <div className="automodPanel">
      {pending.length === 0 ? (
        <p className="muted">No messages currently held.</p>
      ) : (
        pending.map(hold => <AutomodItem key={hold.id} hold={hold} onAllow={allow} onDeny={deny} />)
      )}
      {recentlyResolved.length > 0 ? (
        <div className="automodHistory">
          <p className="automodHistoryLabel">Recently resolved</p>
          {recentlyResolved.map(hold => (
            <div className="automodHistoryItem" key={hold.id}>
              <span>{hold.displayName}</span>
              <em>{hold.resolution}{hold.resolvedBy ? ` · ${hold.resolvedBy}` : ''}</em>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function AutomodQuickActions() {
  const { pending, allow, deny } = useAutomodQueue();

  if (pending.length === 0) return <p className="muted">No messages held.</p>;

  return (
    <div className="automodPanel">
      {pending.map(hold => <AutomodItem key={hold.id} hold={hold} onAllow={allow} onDeny={deny} />)}
    </div>
  );
}
```

Note: `act`'s `finally`-style reset of `busy` only happens on the error path here — on success, the item unmounts almost immediately once `automod:resolved` removes it from `pending`, so there's no stale `busy` state to reset (mirrors the tablet's existing `playSound` error-only reset pattern).

- [ ] **Step 3: Add styles to `src/client/styles.css`**

Add at the end of the file:

```css
/* ── AutoMod queue ────────────────────────────────────────── */

.automodPanel {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.automodItem {
  border: 1px solid #2a3a58;
  border-radius: 8px;
  background: var(--navy-deep);
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.automodItemHead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.automodTag {
  font-size: 11px;
  color: var(--silver);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.automodMessage {
  margin: 0;
  color: var(--ivory);
  overflow-wrap: anywhere;
}

.automodError {
  margin: 0;
  color: #ffb3b3;
  font-size: 12px;
}

.automodItemActions {
  display: flex;
  gap: 8px;
}

.automodItemActions button {
  min-height: 36px;
  padding: 6px 14px;
  border: 1px solid #2f4367;
  border-radius: 8px;
  background: var(--navy);
  color: var(--ivory);
}

.automodItemActions button:hover:not(:disabled) {
  border-color: var(--gold);
}

.automodItemActions button.accent {
  background: var(--arcane);
  border-color: var(--gold);
}

.automodItemActions button.dangerButton {
  background: rgba(255, 85, 85, 0.14);
  border-color: rgba(255, 85, 85, 0.36);
  color: #ffb3b3;
}

.automodHistory {
  border-top: 1px solid #2a3a58;
  margin-top: 4px;
  padding-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.automodHistoryLabel {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--silver);
  margin: 0;
}

.automodHistoryItem {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  font-size: 12px;
  color: var(--silver);
}
```

- [ ] **Step 4: Typecheck**

Run: `bun run typecheck`
Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add src/client/services/dashboard.ts src/client/automod.tsx src/client/styles.css
git commit -m "feat: add AutoMod queue hook and panel components"
```

---

### Task 5: Dashboard wiring — third tab with a pending-count badge

**Files:**
- Modify: `src/client/ui/shell.tsx` (tab badge support)
- Modify: `src/client/pages/Dashboard.tsx` (wire the new tab)
- Modify: `src/client/styles/panel.css` (badge style)

**Interfaces:**
- Consumes: `useAutomodQueue`, `AutomodPanel` (Task 4, `../automod`).

- [ ] **Step 1: Extend the `tabs` prop in `src/client/ui/shell.tsx`**

Change the type (around line 451):

```ts
  tabs?: Array<{ id: string; label: string; badge?: number }>;
```

Change the tab button rendering (around lines 477-486) to show the badge:

```tsx
            {tabs.map(t => (
              <button
                key={t.id}
                className={'panel-tab' + (activeTab === t.id ? ' active' : '')}
                onClick={() => onTabChange?.(t.id)}
                type="button"
              >
                {t.label}
                {t.badge ? <span className="panel-tab-badge">{t.badge}</span> : null}
              </button>
            ))}
```

- [ ] **Step 2: Add the badge style to `src/client/styles/panel.css`**

Add after `.panel-tab.active` (line 853):

```css
.panel-tab-badge {
  margin-left: 6px; padding: 0 5px; min-width: 15px; display: inline-block; text-align: center;
  font-size: 10px; line-height: 15px; border-radius: var(--radius-pill);
  background: var(--danger-bg); color: var(--danger-fg); border: 1px solid var(--danger-border);
}
```

- [ ] **Step 3: Wire the tab into `src/client/pages/Dashboard.tsx`**

Add the import (alongside the other page-local imports near the top):

```ts
import { useAutomodQueue, AutomodPanel } from '../automod';
```

Change the `rightTab` state type (line 129):

```ts
  const [rightTab, setRightTab] = useState<'activity' | 'chatters' | 'automod'>('activity');
```

Add the hook call near the `chatters` state (after line 128's `chattersError` declaration):

```ts
  const automodQueue = useAutomodQueue();
```

Update the `events` Panel block (around lines 529-546) — change `count`, `tabs`, `onTabChange`, and the body ternary:

```tsx
        <Panel
          id="events"
          title="activity feed"
          dot={true}
          count={
            rightTab === 'activity'
              ? MODULES.events.count?.(ctx)
              : rightTab === 'chatters'
                ? chatters.length
                : automodQueue.pending.length
          }
          popped={!!popped['events']}
          onPop={handlePop}
          tabs={[
            { id: 'activity', label: 'Activity' },
            { id: 'chatters', label: 'Chatters' },
            { id: 'automod', label: 'AutoMod', badge: automodQueue.pending.length },
          ]}
          activeTab={rightTab}
          onTabChange={id => setRightTab(id as 'activity' | 'chatters' | 'automod')}
        >
          {rightTab === 'activity'
            ? MODULES.events.render(ctx)
            : rightTab === 'chatters'
              ? <ChattersPanel chatters={chatters} viewers={viewers} error={chattersError} onOpenViewer={ctx.openViewerPopout} />
              : <AutomodPanel />}
        </Panel>
```

- [ ] **Step 4: Typecheck**

Run: `bun run typecheck`
Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add src/client/ui/shell.tsx src/client/pages/Dashboard.tsx src/client/styles/panel.css
git commit -m "feat: add AutoMod tab to the dashboard activity panel"
```

---

### Task 6: Tablet wiring + full manual verification

**Files:**
- Modify: `src/client/pages/Tablet.tsx`

**Interfaces:**
- Consumes: `AutomodQuickActions` (Task 4, `../automod`).

- [ ] **Step 1: Add the AutoMod section to `src/client/pages/Tablet.tsx`**

Add the import:

```ts
import { AutomodQuickActions } from '../automod';
```

Add a new section after the existing "Sounds" `<section>` (after its closing `</section>`, before the closing `</div>` of `.tabletControlGrid`):

```tsx
        <section className="tabletPanel">
          <div className="tabletPanelHeader">
            <div>
              <p className="eyebrow">Moderation</p>
              <h2>AutoMod Queue</h2>
            </div>
          </div>
          <AutomodQuickActions />
        </section>
```

- [ ] **Step 2: Typecheck and build**

Run: `bun run typecheck && bun run build`
Expected: both succeed with no errors

- [ ] **Step 3: Run the full server test suite**

Run: `bun test`
Expected: all tests pass, including the new `automod.test.ts` and the two new `eventsub.test.ts` cases

- [ ] **Step 4: Manual verification in-browser**

Start the dev server (`bun run dev`), confirm port 4317/5173 are free first per project convention. Then:
1. Open `/` (Dashboard) — click the new "AutoMod" tab in the activity panel. Confirm it shows "No messages currently held." and no badge.
2. Open `/tablet` in a second tab — confirm the new "AutoMod Queue" section renders "No messages held."
3. Since a real AutoMod hold requires live Twitch chat activity (and the new `moderator:manage:automod` scope needs a Twitch reconnect first — flag this to the user if `twitchMissingScopes` shows it), simulate one instead: in a `bun repl` or scratch script, import `recordAutomodHold` from `src/server/automod.ts` and call it with a synthetic hold while the dev server is running — confirm it appears live on both the Dashboard's AutoMod tab (with a "1" badge visible even while on the Activity tab) and the Tablet's card, and that clicking Allow/Deny clears it from both (the Deny/Allow call will fail against the real Twitch API without a live message id — that's expected for this synthetic check; what's being verified is that the WebSocket broadcast and UI wiring work, not the live Twitch call, which was already covered by Task 3's typecheck and existing codebase conventions).
5. Stop the dev server when done.

- [ ] **Step 5: Commit**

```bash
git add src/client/pages/Tablet.tsx
git commit -m "feat: add AutoMod quick actions to the tablet"
```

---

## Post-implementation note for the PR description

Call out in the PR: this ships a new required Twitch OAuth scope (`moderator:manage:automod`) — existing installs need to reconnect Twitch once from Settings after deploying, or the two new EventSub subscriptions will silently fail (the existing `subscribeToAllEvents` loop already tolerates and logs this without blocking other subscriptions).
