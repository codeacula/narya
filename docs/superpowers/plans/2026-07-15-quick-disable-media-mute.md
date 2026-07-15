# Quick Disable + Master Media Mute Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persisted, single master "mute sound/video commands" toggle (dashboard + tablet) that silences only the Actions the operator has opted in via a per-Action "Quick Disable" flag.

**Architecture:** A per-Action boolean (`actions.quick_disable`) marks which Actions the master mute may silence. A persisted single-row `media_mute` table holds the global mute state, exposed by a small `mediaMute.ts` module with its own routes + `media:mute` broadcast (off the `app_config`/Settings reconnect path). Enforcement is a single check at the top of `runAction` in `actionExecutor.ts`: `muted && action.quickDisable` → `skipped`, broadcasting nothing — so every invocation source (command, reward, manual, module) honors it with no new play path.

**Tech Stack:** Bun, TypeScript (strict), Express, `bun:sqlite`, React, Vite. Tests via `bun test` (`*.test.ts`, in-memory DB under `NODE_ENV=test`).

## Global Constraints

- Two-space indentation; TypeScript strict mode; no linter/formatter — match surrounding style.
- All client/server API + WebSocket contracts live in `src/shared/api.ts`; import them, do not duplicate.
- `media:mute` must **NOT** be added to the overlay event allowlist — it carries operator control state. `broadcast()` already withholds non-allowlisted events from overlay-role sockets, so no allowlist change is needed or wanted.
- `actions.quick_disable` column definition is exactly `integer not null default 0`.
- The mute persists across restart (single-row `media_mute` table); it is deliberately **not** reused from the in-memory overlay-placeholder mechanism.
- Enforcement lives **only** in `runAction` — do not add a second mute check on any trigger path (that would fork behavior). Manual runs of a flagged Action are suppressed while muted; this is intended.
- Semantic commits: `feat:`, `test:`, `chore:` etc., short imperative description.
- Baseline after each task: `bun run typecheck`. Full gate before finishing: `bun run typecheck && bun test && bun run build`.

---

## File Structure

**Create:**
- `src/server/mediaMute.ts` — persisted mute store: `getMediaMuted`, `setMediaMuted`, `registerMediaMuteRoutes`.
- `src/server/mediaMute.test.ts` — round-trip + default tests.
- `src/client/mediaMute.ts` — `useMediaMute()` hook (state + `media:mute` socket + toggle).

**Modify:**
- `src/shared/api.ts` — `MediaMuteState`; `quickDisable` on `Action` and `ActionUpsert`.
- `src/server/db.ts` — `media_mute` table; `actions.quick_disable` column + allowlist entries.
- `src/server/actions.ts` — persist/read/normalize `quickDisable`.
- `src/server/actions.test.ts` — `quickDisable` round-trip.
- `src/server/actionExecutor.ts` — `isMuted` dep + the mute check in `runAction`.
- `src/server/actionExecutor.test.ts` — mute-enforcement tests + `action()` helper gains `quickDisable`.
- `src/server/automation.ts` — wire `isMuted: () => getMediaMuted()`.
- `src/server/index.ts` — register mute routes.
- `src/client/services/dashboard.ts` — `getMediaMute` / `setMediaMute`.
- `src/client/pages/settings/ActionsPage.tsx` — "Quick Disable" checkbox; `EMPTY_DRAFT`.
- `src/client/pages/settings/automation.ts` — `actionToUpsert` carries `quickDisable`.
- `src/client/pages/settings/automation.test.ts` — assert `actionToUpsert` carries `quickDisable`.
- `src/client/ui/panels.tsx` — `MediaMuteToggle` rendered in `ControlsPanel`.
- `src/client/pages/Tablet.tsx` — mute button in the Media panel header.

---

## Task 1: Persisted media-mute store, type, routes, broadcast

**Files:**
- Modify: `src/shared/api.ts` (add `MediaMuteState`)
- Modify: `src/server/db.ts` (add `media_mute` table to the schema block)
- Create: `src/server/mediaMute.ts`
- Create: `src/server/mediaMute.test.ts`
- Modify: `src/server/index.ts` (register routes)

**Interfaces:**
- Produces:
  - `MediaMuteState = { muted: boolean }` (in `src/shared/api.ts`)
  - `getMediaMuted(): boolean`
  - `setMediaMuted(muted: boolean): MediaMuteState` — persists then `broadcast('media:mute', state)`
  - `registerMediaMuteRoutes(app: express.Express): void` — `GET`/`PUT /api/automation/media-mute`

- [ ] **Step 1: Add the shared type**

In `src/shared/api.ts`, near the `OverlayPlaceholders` type, add:

```ts
/** `media:mute` WebSocket payload and the GET/PUT /api/automation/media-mute body. */
export type MediaMuteState = {
  muted: boolean;
};
```

- [ ] **Step 2: Add the `media_mute` table**

In `src/server/db.ts`, inside the large `db.exec(\`...\`)` schema block that contains `create table if not exists actions (`, add this table (place it right after the `actions` table for locality):

```sql
  -- Single-row master switch: while muted = 1, the executor skips any Action whose
  -- quick_disable flag is set. Persisted (survives restart) unlike the in-memory
  -- overlay-placeholder flag, because a mid-stream restart must not silently un-mute.
  create table if not exists media_mute (
    id integer primary key check (id = 1),
    muted integer not null default 0
  );
```

- [ ] **Step 3: Write the failing test**

Create `src/server/mediaMute.test.ts`:

```ts
import { beforeEach, describe, expect, mock, test } from 'bun:test';

// Bind the module under test to a broadcast spy (static imports are hoisted, so the
// module is imported dynamically below, after the mock is installed).
const emitted: Array<{ event: string; payload: unknown }> = [];
const realtime = await import('./realtime');
mock.module('./realtime', () => ({
  ...realtime,
  broadcast: (event: string, payload: unknown) => { emitted.push({ event, payload }); },
}));

const { getMediaMuted, setMediaMuted } = await import('./mediaMute');
const { db } = await import('./db');

beforeEach(() => {
  db.exec('delete from media_mute');
  emitted.length = 0;
});

describe('media mute store', () => {
  test('defaults to false when no row exists', () => {
    expect(getMediaMuted()).toBe(false);
  });

  test('persists mute on and off', () => {
    expect(setMediaMuted(true)).toEqual({ muted: true });
    expect(getMediaMuted()).toBe(true);
    expect(setMediaMuted(false)).toEqual({ muted: false });
    expect(getMediaMuted()).toBe(false);
  });

  test('broadcasts media:mute on every change', () => {
    setMediaMuted(true);
    expect(emitted).toEqual([{ event: 'media:mute', payload: { muted: true } }]);
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `bun test src/server/mediaMute.test.ts`
Expected: FAIL — cannot resolve `./mediaMute`.

- [ ] **Step 5: Implement `mediaMute.ts`**

Create `src/server/mediaMute.ts`:

```ts
import type express from 'express';
import type { MediaMuteState } from '../shared/api';
import { db } from './db';
import { broadcast } from './realtime';

/**
 * The master "mute sound/video commands" switch. A single row (id = 1) so it
 * persists across restart — a mid-stream restart must not silently un-mute. The
 * executor reads getMediaMuted() and skips any quick-disable Action while it is on.
 *
 * Deliberately off the app_config / Settings path: a mute must never trigger a
 * Twitch/OBS reconnect, and it is flipped from a Stream Controls button, not the
 * credentials form.
 */
const readRow = db.prepare('select muted from media_mute where id = 1');
const writeRow = db.prepare(
  'insert into media_mute (id, muted) values (1, ?) on conflict(id) do update set muted = excluded.muted',
);

export function getMediaMuted(): boolean {
  const row = readRow.get() as { muted: number } | null;
  return row?.muted === 1;
}

export function setMediaMuted(muted: boolean): MediaMuteState {
  writeRow.run(muted ? 1 : 0);
  const state: MediaMuteState = { muted };
  // Dashboard and tablet seed from the GET on load and track this event afterwards,
  // so every operator surface reflects the switch without a manual refresh.
  broadcast('media:mute', state);
  return state;
}

/**
 * Operator-only: requireDashboardToken already gates /api. This is never on the
 * overlay token's read allowlist — a browser source has no business reading or
 * flipping the mute.
 */
export function registerMediaMuteRoutes(app: express.Express) {
  app.get('/api/automation/media-mute', (_request, response) => {
    response.json({ muted: getMediaMuted() } satisfies MediaMuteState);
  });

  app.put('/api/automation/media-mute', (request, response) => {
    const muted = (request.body as { muted?: unknown } | null)?.muted === true;
    response.json(setMediaMuted(muted));
  });
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `bun test src/server/mediaMute.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 7: Register the routes**

In `src/server/index.ts`, add the import alongside the other route imports (near line 18, the `registerOverlayPlaceholderRoutes` import):

```ts
import { registerMediaMuteRoutes } from './mediaMute';
```

And register it next to `registerOverlayPlaceholderRoutes(app);` (near line 129):

```ts
registerMediaMuteRoutes(app);
```

- [ ] **Step 8: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add src/shared/api.ts src/server/db.ts src/server/mediaMute.ts src/server/mediaMute.test.ts src/server/index.ts
git commit -m "feat: persisted master media-mute store, routes, and broadcast"
```

---

## Task 2: `quick_disable` column and Action repository round-trip

**Files:**
- Modify: `src/shared/api.ts` (`quickDisable` on `Action`, `ActionUpsert`)
- Modify: `src/server/db.ts` (allowlist + `addColumnIfMissing`)
- Modify: `src/server/actions.ts`
- Modify: `src/server/actions.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `Action.quickDisable: boolean` and `ActionUpsert.quickDisable: boolean` (in `src/shared/api.ts`)
  - `createAction`/`updateAction`/`getActionById`/`listActions` persist and return `quickDisable`.

- [ ] **Step 1: Write the failing test**

In `src/server/actions.test.ts`, add this `describe` block at the end of the file (the existing `upsert()` helper already spreads `overrides`, so `{ quickDisable: true }` flows through):

```ts
describe('quickDisable persistence', () => {
  test('defaults to false and round-trips through create/read', () => {
    const created = createAction(upsert());
    expect(created.quickDisable).toBe(false);
    expect(getActionById(created.id)!.quickDisable).toBe(false);
  });

  test('persists quickDisable = true and can be toggled back off', () => {
    const created = createAction(upsert([step()], { name: 'Fart', quickDisable: true }));
    expect(created.quickDisable).toBe(true);

    const updated = updateAction(created.id, upsert([step()], { name: 'Fart', quickDisable: false }));
    expect(updated.quickDisable).toBe(false);
    expect(getActionById(created.id)!.quickDisable).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/server/actions.test.ts`
Expected: FAIL — `created.quickDisable` is `undefined` (TS error / assertion failure).

- [ ] **Step 3: Add the shared contract fields**

In `src/shared/api.ts`, add `quickDisable` to both types:

```ts
export type Action = {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  /** When true, the master media mute (Stream Controls) silences this Action. */
  quickDisable: boolean;
  steps: ActionStep[];
  createdAt: string;
  updatedAt: string;
};

export type ActionUpsert = {
  name: string;
  description: string;
  enabled: boolean;
  quickDisable: boolean;
  steps: ActionStepInput[];
};
```

- [ ] **Step 4: Add the column + migration allowlist**

In `src/server/db.ts`:

(a) Add `'actions'` to the `allowedMigrationTables` set (the set that ends with `'alert_settings',` then `]);` — add the line):

```ts
  'actions',
```

(b) Add `'quick_disable'` to the `allowedMigrationColumns` set:

```ts
  'quick_disable',
```

(c) Add the definition to `allowedMigrationDefinitions` (lowercased, matching the guard):

```ts
  quick_disable: 'integer not null default 0',
```

(d) Add the migration call next to the other `addColumnIfMissing` calls (after the `sound_button_volume` line is fine):

```ts
addColumnIfMissing('actions', 'quick_disable', 'integer not null default 0');
```

- [ ] **Step 5: Persist and read the flag in the repository**

In `src/server/actions.ts`, make these edits:

(a) `ActionRow` type — add the field:

```ts
type ActionRow = {
  id: string;
  name: string;
  description: string;
  enabled: number;
  quickDisable: number;
  createdAt: string;
  updatedAt: string;
};
```

(b) Both select statements (`listActionRows`, `getActionRow`) — add `quick_disable as quickDisable` to the column list. For `listActionRows`:

```ts
const listActionRows = db.prepare(`
  select id, name, description, enabled, quick_disable as quickDisable, created_at as createdAt, updated_at as updatedAt
  from actions
  order by name collate nocase
`);
```

And identically for `getActionRow`:

```ts
const getActionRow = db.prepare(`
  select id, name, description, enabled, quick_disable as quickDisable, created_at as createdAt, updated_at as updatedAt
  from actions
  where id = ?
`);
```

(c) `insertActionRow` and `updateActionRow` — add the column:

```ts
const insertActionRow = db.prepare(`
  insert into actions (id, name, description, enabled, quick_disable, created_at, updated_at)
  values (?, ?, ?, ?, ?, ?, ?)
`);

const updateActionRow = db.prepare(`
  update actions
  set name = ?, description = ?, enabled = ?, quick_disable = ?, updated_at = ?
  where id = ?
`);
```

(d) `normalizeActionUpsert` return — add `quickDisable`:

```ts
  return {
    name,
    description,
    enabled: typeof value.enabled === 'boolean' ? value.enabled : true,
    quickDisable: typeof value.quickDisable === 'boolean' ? value.quickDisable : false,
    steps: normalizeSteps(value.steps),
  };
```

(e) `createActionRecord` and `updateActionRecord` transactions — pass the value (order matches the SQL above):

```ts
const createActionRecord = db.transaction((settings: ActionUpsert) => {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  insertActionRow.run(id, settings.name, settings.description, settings.enabled ? 1 : 0, settings.quickDisable ? 1 : 0, now, now);
  saveSteps(id, settings.steps, now);
  return id;
});

const updateActionRecord = db.transaction((id: string, settings: ActionUpsert) => {
  const now = new Date().toISOString();
  updateActionRow.run(settings.name, settings.description, settings.enabled ? 1 : 0, settings.quickDisable ? 1 : 0, now, id);
  saveSteps(id, settings.steps, now);
});
```

(f) `rowToAction` — surface it:

```ts
function rowToAction(row: ActionRow): Action {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    enabled: row.enabled === 1,
    quickDisable: row.quickDisable === 1,
    steps: (listStepRows.all(row.id) as StepRow[]).map(rowToStep),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `bun test src/server/actions.test.ts`
Expected: PASS (existing tests + the 2 new ones).

- [ ] **Step 7: Typecheck**

Run: `bun run typecheck`
Expected: errors in `src/server/actionExecutor.test.ts` and client files that build `Action`/`ActionUpsert` literals without `quickDisable`. **These are fixed in Tasks 3 and 5** — if you are running tasks out of order, note them; otherwise proceed, the next task addresses the executor test.

- [ ] **Step 8: Commit**

```bash
git add src/shared/api.ts src/server/db.ts src/server/actions.ts src/server/actions.test.ts
git commit -m "feat: add per-Action quickDisable flag and persist it"
```

---

## Task 3: Executor enforces the mute (single choke point)

**Files:**
- Modify: `src/server/actionExecutor.ts`
- Modify: `src/server/actionExecutor.test.ts`
- Modify: `src/server/automation.ts`

**Interfaces:**
- Consumes: `getMediaMuted()` (Task 1); `Action.quickDisable` (Task 2).
- Produces: `ActionExecutorDeps.isMuted?: () => boolean` (defaults to `() => false`). `runAction` returns a `skipped` result with no broadcasts when `isMuted() && action.quickDisable`.

- [ ] **Step 1: Update the test's `action()` helper for the new required field**

In `src/server/actionExecutor.test.ts`, the `action()` helper builds an `Action` literal. Add `quickDisable: false` before `...overrides` so the literal satisfies the type and overrides can flip it:

```ts
function action(steps: ActionStep[], overrides: Partial<Action> = {}): Action {
  return {
    id: 'action-1',
    name: 'Test action',
    description: '',
    enabled: true,
    quickDisable: false,
    steps: steps.map((s, index) => ({ ...s, id: s.id === 'step-1' ? `step-${index + 1}` : s.id, position: index })),
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}
```

- [ ] **Step 2: Write the failing tests**

In `src/server/actionExecutor.test.ts`, add this `describe` block (the `harness()` `overrides` param already forwards any `ActionExecutorDeps`, so `isMuted` passes straight through):

```ts
describe('master media mute', () => {
  test('skips a quick-disable action while muted and broadcasts nothing', async () => {
    const target = action(
      [step({ type: 'send_chat', payload: { template: 'hi', sender: 'bot' } } as never)],
      { quickDisable: true },
    );
    const h = harness(target, { isMuted: () => true });
    const result = await run(h);

    expect(result.status).toBe('skipped');
    expect(result.steps).toEqual([]);
    expect(h.calls.broadcasts).toEqual([]);
    expect(h.calls.chats).toEqual([]);
  });

  test('runs a quick-disable action when not muted', async () => {
    const target = action(
      [step({ type: 'send_chat', payload: { template: 'hi', sender: 'bot' } } as never)],
      { quickDisable: true },
    );
    const h = harness(target, { isMuted: () => false });
    const result = await run(h);

    expect(result.status).toBe('succeeded');
    expect(h.calls.chats).toEqual([{ message: 'hi', sender: 'bot' }]);
  });

  test('runs an unflagged action even while muted', async () => {
    const target = action(
      [step({ type: 'send_chat', payload: { template: 'hi', sender: 'bot' } } as never)],
      { quickDisable: false },
    );
    const h = harness(target, { isMuted: () => true });
    const result = await run(h);

    expect(result.status).toBe('succeeded');
    expect(h.calls.chats).toEqual([{ message: 'hi', sender: 'bot' }]);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test src/server/actionExecutor.test.ts`
Expected: FAIL — the first case runs the chat step (mute not yet enforced); `isMuted` is not a known dep.

- [ ] **Step 4: Add the `isMuted` dependency**

In `src/server/actionExecutor.ts`, add to `ActionExecutorDeps` (in the "seam for tests" group):

```ts
  /** The master media mute. When true, a quickDisable Action is skipped silently. */
  isMuted?: () => boolean;
```

And add it to the destructured defaults in `createActionExecutor` (alongside `now = () => new Date()`):

```ts
    isMuted = () => false,
```

- [ ] **Step 5: Enforce the mute in `runAction`**

In `src/server/actionExecutor.ts`, update `runAction` to add the check right after the missing/disabled guard:

```ts
  async function runAction(actionId: string, context: TemplateContext): Promise<ActionRunResult> {
    const ranAt = now().toISOString();
    const action = loadAction(actionId);

    // A missing or disabled Action broadcasts nothing at all.
    if (!action || !action.enabled) {
      return { actionId, status: 'skipped', steps: [], ranAt };
    }

    // Master media mute: an opted-in Action is skipped silently while muted. This is
    // the single choke point, so every source — command, reward, manual, module —
    // honors it uniformly, and a skipped run broadcasts nothing (no media:play, no
    // overlay:text), so overlays stay quiet with no new play path.
    if (action.quickDisable && isMuted()) {
      return { actionId, status: 'skipped', steps: [], ranAt };
    }

    const steps = await Promise.all(action.steps.map(step => runStep(step, context)));
    return { actionId, status: rollUp(steps), steps, ranAt };
  }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun test src/server/actionExecutor.test.ts`
Expected: PASS (existing tests + the 3 new ones).

- [ ] **Step 7: Wire the real mute into the composition root**

In `src/server/automation.ts`, import the getter and pass it to the executor:

```ts
import { getMediaMuted } from './mediaMute';
```

```ts
  executor = createActionExecutor({
    resolveMedia: resolveMediaAssetForPlayback,
    state,
    isMuted: () => getMediaMuted(),
  });
```

- [ ] **Step 8: Run the redeem-double-play regression + typecheck**

Run: `bun test src/server/redeemOnce.test.ts && bun run typecheck`
Expected: PASS; no type errors in server code. (Client `Action`/`ActionUpsert` literal errors are addressed in Tasks 5–6.)

- [ ] **Step 9: Commit**

```bash
git add src/server/actionExecutor.ts src/server/actionExecutor.test.ts src/server/automation.ts
git commit -m "feat: skip quickDisable actions in the executor while media-muted"
```

---

## Task 4: Client service helpers + `useMediaMute` hook

**Files:**
- Modify: `src/client/services/dashboard.ts`
- Create: `src/client/mediaMute.ts`

**Interfaces:**
- Consumes: `MediaMuteState` (Task 1); the REST routes from Task 1.
- Produces:
  - `getMediaMute(): Promise<MediaMuteState>`, `setMediaMute(muted: boolean): Promise<MediaMuteState>`
  - `useMediaMute(): { muted: boolean; busy: boolean; toggle: (next: boolean) => void }`

- [ ] **Step 1: Add the service helpers**

In `src/client/services/dashboard.ts`:

(a) Add `MediaMuteState` to the type import block that already imports `OverlayPlaceholders` (near line 72):

```ts
  MediaMuteState,
```

(b) Add the two functions after `updateOverlayPlaceholders` (near line 531):

```ts
// Master media mute (Stream Controls). Operator-only; never on the overlay allowlist.
export async function getMediaMute(): Promise<MediaMuteState> {
  return fetchJson<MediaMuteState>('/api/automation/media-mute');
}

export async function setMediaMute(muted: boolean): Promise<MediaMuteState> {
  return sendJson<MediaMuteState>('/api/automation/media-mute', 'PUT', { muted });
}
```

- [ ] **Step 2: Create the hook**

Create `src/client/mediaMute.ts`:

```ts
import React from 'react';
import type { MediaMuteState } from '../shared/api';
import { getMediaMute, setMediaMute } from './services/dashboard';
import { useSocket } from './realtime';

/**
 * Shared state for the master media mute so the dashboard and the tablet stay in
 * sync: both seed from GET on mount, flip via PUT, and track `media:mute` so a
 * toggle on one surface lights the button on the other without a refresh.
 */
export function useMediaMute() {
  const [muted, setMuted] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    getMediaMute()
      .then(state => setMuted(state.muted))
      .catch(() => setMuted(false));
  }, []);

  useSocket<MediaMuteState>(
    'media:mute',
    React.useCallback((next: MediaMuteState) => setMuted(next.muted), []),
  );

  const toggle = React.useCallback((next: boolean) => {
    setBusy(true);
    setMediaMute(next)
      .then(state => setMuted(state.muted))
      .catch(() => undefined)
      .finally(() => setBusy(false));
  }, []);

  return { muted, busy, toggle };
}
```

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: no new errors from these two files (client `Action`/`ActionUpsert` literal errors from Task 2 remain until Task 5).

- [ ] **Step 4: Commit**

```bash
git add src/client/services/dashboard.ts src/client/mediaMute.ts
git commit -m "feat: client media-mute service helpers and useMediaMute hook"
```

---

## Task 5: "Quick Disable" checkbox in the Actions editor

**Files:**
- Modify: `src/client/pages/settings/ActionsPage.tsx`
- Modify: `src/client/pages/settings/automation.ts`
- Modify: `src/client/pages/settings/automation.test.ts`

**Interfaces:**
- Consumes: `ActionUpsert.quickDisable` (Task 2).
- Produces: nothing new; edits Actions to set `quickDisable`.

- [ ] **Step 1: Write the failing test for the mapping**

In `src/client/pages/settings/automation.test.ts`, add a test asserting `actionToUpsert` carries `quickDisable`. (Match the existing import style in that file; `actionToUpsert` is exported from `./automation`.) Add:

```ts
import { actionToUpsert } from './automation';
import type { Action } from '../../../shared/api';

test('actionToUpsert carries quickDisable through', () => {
  const action: Action = {
    id: 'a1',
    name: 'Fart',
    description: '',
    enabled: true,
    quickDisable: true,
    steps: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  expect(actionToUpsert(action).quickDisable).toBe(true);
});
```

(If `test`/`expect` are not already imported in that file, add `import { expect, test } from 'bun:test';` — check the file header first and reuse its existing import if present.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/client/pages/settings/automation.test.ts`
Expected: FAIL — `actionToUpsert(...).quickDisable` is `undefined`.

- [ ] **Step 3: Carry the flag through `actionToUpsert`**

In `src/client/pages/settings/automation.ts`:

```ts
export function actionToUpsert(action: Action): ActionUpsert {
  return {
    name: action.name,
    description: action.description,
    enabled: action.enabled,
    quickDisable: action.quickDisable,
    steps: action.steps.map(stepToInput),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/client/pages/settings/automation.test.ts`
Expected: PASS.

- [ ] **Step 5: Default the flag in `EMPTY_DRAFT`**

In `src/client/pages/settings/ActionsPage.tsx`:

```ts
const EMPTY_DRAFT: ActionUpsert = { name: '', description: '', enabled: true, quickDisable: false, steps: [] };
```

- [ ] **Step 6: Add the checkbox next to "Enabled"**

In `src/client/pages/settings/ActionsPage.tsx`, in the `settings-mini-form` block, add a second toggle right after the existing "Enabled" `label.command-enabled` (around line 783):

```tsx
                <label className="command-enabled">
                  <input
                    type="checkbox"
                    checked={draft.quickDisable}
                    disabled={busy}
                    onChange={event => setDraft(current => (current ? { ...current, quickDisable: event.target.checked } : current))}
                  />
                  <span>Quick Disable</span>
                </label>
```

Then add a hint line under the form's fields (inside the same `settings-mini-form`, after the two toggles) so the operator knows what it does:

```tsx
                <small className="action-hint">
                  Quick Disable lets the "Mute sound/video commands" button in Stream Controls silence this action.
                </small>
```

- [ ] **Step 7: Show a tag on muted-eligible actions in the list (optional but cheap)**

In the left-hand action list `media-asset-tags` block (around line 698), add a tag so a flagged action is visible at a glance:

```tsx
                        {action.quickDisable && <span className="media-asset-tag">quick-disable</span>}
```

- [ ] **Step 8: Typecheck + build**

Run: `bun run typecheck && bun run build`
Expected: no errors (this resolves the remaining `ActionUpsert`/`Action` literal errors introduced in Task 2).

- [ ] **Step 9: Commit**

```bash
git add src/client/pages/settings/ActionsPage.tsx src/client/pages/settings/automation.ts src/client/pages/settings/automation.test.ts
git commit -m "feat: Quick Disable checkbox in the Actions editor"
```

---

## Task 6: Master mute button on dashboard and tablet

**Files:**
- Modify: `src/client/ui/panels.tsx`
- Modify: `src/client/pages/Tablet.tsx`

**Interfaces:**
- Consumes: `useMediaMute()` (Task 4).
- Produces: nothing new (UI only).

- [ ] **Step 1: Add the dashboard toggle to `ControlsPanel`**

In `src/client/ui/panels.tsx`:

(a) Import the hook near the top of the file (with the other client-module imports):

```ts
import { useMediaMute } from '../mediaMute';
```

(b) Add a `MediaMuteToggle` component next to `OverlayPlaceholderToggle` (mirror its structure):

```tsx
/**
 * The master "mute sound/video commands" switch. While engaged, the server skips
 * every Action flagged Quick Disable — spammed sound/video commands go quiet at
 * once, while unflagged redemptions keep working. Persisted, so a restart keeps it
 * lit until the operator turns it off.
 */
function MediaMuteToggle() {
  const { muted, busy, toggle } = useMediaMute();

  return (
    <div className="ctrl-section ctrl-mute-section">
      <span className="ctrl-label">commands</span>
      <label className={'ctrl-toggle' + (muted ? ' is-muted' : '')}>
        <input
          type="checkbox"
          checked={muted}
          disabled={busy}
          onChange={event => toggle(event.target.checked)}
        />
        <span>Mute sound/video commands</span>
      </label>
      {muted && (
        <p className="ctrl-overlay-warning" role="status">
          Quick-Disable actions are silenced. Redemptions on unflagged actions still play.
        </p>
      )}
    </div>
  );
}
```

(c) Render it in `ControlsPanel` right after `<OverlayPlaceholderToggle />` (line 1268):

```tsx
      <OverlayPlaceholderToggle />
      <MediaMuteToggle />
```

- [ ] **Step 2: Add the tablet button in the Media panel header**

In `src/client/pages/Tablet.tsx`:

(a) Import the hook (with the other imports near the top):

```ts
import { useMediaMute } from '../mediaMute';
```

(b) Call the hook inside `TabletPage` (near the other hook calls, ~line 66):

```ts
  const media = useMediaMute();
```

(c) In the Media panel header (`tabletPanelHeader` around lines 198–203), add a mute button next to the "Media" heading:

```tsx
            <div className="tabletPanelHeader">
              <div>
                <p className="eyebrow">Soundboard</p>
                <h2>Media</h2>
              </div>
              <button
                type="button"
                className={'tabletMuteButton' + (media.muted ? ' active' : '')}
                aria-pressed={media.muted}
                disabled={media.busy}
                onClick={event => { blurIfPointer(event); media.toggle(!media.muted); }}
              >
                {media.muted ? '🔇 Commands muted' : '🔊 Mute commands'}
              </button>
            </div>
```

- [ ] **Step 3: Add minimal styles for the lit states**

Add rules so the engaged state reads clearly. Dashboard classes live in `src/client/styles/panel.css` (kebab-case, e.g. `.ctrl-toggle`); the tablet button lives in `src/client/styles.css` (camelCase, e.g. `.tabletMuteButton`). Add, in `panel.css`:

```css
.ctrl-toggle.is-muted span { color: var(--danger, #ff6b6b); font-weight: 600; }
```

And in `styles.css`:

```css
.tabletMuteButton { border: 1px solid var(--line, #333); border-radius: 8px; padding: 8px 12px; }
.tabletMuteButton.active { background: var(--danger, #ff6b6b); color: #1a1a1a; font-weight: 700; }
```

(Match whatever token variables the surrounding CSS already uses; the fallbacks keep it working if a token name differs.)

- [ ] **Step 4: Typecheck + build**

Run: `bun run typecheck && bun run build`
Expected: no errors.

- [ ] **Step 5: Full test gate**

Run: `bun test`
Expected: all pass, including `mediaMute`, `actions`, `actionExecutor`, `redeemOnce`, and `automation` (client).

- [ ] **Step 6: Visible verification (do not skip — a binding/UI change is not proven by typecheck)**

Start the app against a scratch DB so the operator's data is untouched:

```bash
STREAMER_TOOLS_DB=/tmp/quackmute-scratch.sqlite bun run dev
```

Then, in a browser via the preview tools:
1. In Settings → Actions, create an Action with a single `play_media` step, check **Quick Disable**, save. Create a second Action (also `play_media`) left **unflagged**.
2. Point a `viewer_command` trigger (`!fart`) at the flagged Action, and a manual/reward trigger at the unflagged one (or just use each Action's **Run** button).
3. Open `/tablet`. Toggle **Mute commands** on — confirm it lights red.
4. Run the flagged Action (its Run button in Settings, or fire `!fart`): confirm **no** media plays and the run result is `skipped`.
5. Run the unflagged Action: confirm it **still plays**.
6. Confirm the dashboard Controls toggle and the tablet button reflect each other (flip one, watch the other).
7. Restart the dev server; reload `/tablet`; confirm the button comes back **lit** (persistence).
8. Toggle off; confirm the flagged Action plays again.

Capture a screenshot of the tablet with the button lit for the PR.

- [ ] **Step 7: Commit**

```bash
git add src/client/ui/panels.tsx src/client/pages/Tablet.tsx src/client/styles/panel.css src/client/styles.css
git commit -m "feat: master media-mute button on dashboard and tablet"
```

---

## Self-Review

**Spec coverage:**
- Per-Action Quick Disable flag → Task 2 (column + contract) + Task 5 (editor checkbox). ✓
- Master mute, single button → Task 1 (store/routes/broadcast) + Task 6 (dashboard + tablet). ✓
- Opt-in: mute acts only on flagged Actions → Task 3 (`action.quickDisable && isMuted()`). ✓
- Persist across restart, lit on tablet → Task 1 (`media_mute` table) + Task 4 (hook seeds from GET) + Task 6 (lit states) + Task 6 Step 6.7 (restart check). ✓
- Manual runs suppressed while muted → Task 3 (check in `runAction`, below the dispatcher). ✓
- No new play path / no double-play → Task 3 (skipped broadcasts nothing) + Task 3 Step 8 (`redeemOnce.test.ts`). ✓
- `media:mute` off the overlay allowlist → Global Constraints + Task 1 (no allowlist edit). ✓
- Off the app_config/reconnect path → Task 1 (dedicated module + routes). ✓

**Placeholder scan:** No TBD/TODO; every code step shows the exact code. ✓

**Type consistency:** `quickDisable` (camel) in TS / `quick_disable` (snake) in SQL used consistently; `MediaMuteState = { muted: boolean }` used identically in `mediaMute.ts`, service helpers, and the hook; `isMuted` dep name matches between `actionExecutor.ts`, its test, and `automation.ts`; `getMediaMuted`/`setMediaMuted` (server) vs `getMediaMute`/`setMediaMute` (client service) are deliberately distinct names for distinct layers. ✓

**Note for the implementer:** Task 2 Step 7 intentionally leaves the tree with client type errors (missing `quickDisable` on literals) that Tasks 5–6 resolve. If running strictly one commit at a time with a green typecheck gate per commit, do Task 2 and Task 5's `EMPTY_DRAFT`/`actionToUpsert` edits close together, or accept that the client typecheck is red between those tasks (server tests still pass).
