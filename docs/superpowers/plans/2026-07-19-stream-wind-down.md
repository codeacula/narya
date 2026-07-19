# Stream Wind-Down Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the operator declare when they plan to end the stream, and automatically signal a prospective raider — via the Twitch title and an overlay countdown — that the stream is wrapping up, some configurable number of minutes beforehand.

**Architecture:** Two single-row SQLite tables (settings and runtime state) following the existing `go_live_settings` and `media_mute` patterns, a pure decision function driving a tick loop modeled on `automaticAds.ts`, a new `/overlay/winddown` browser source, and a `set_wind_down` Action step. Twitch is touched through one narrow call that PATCHes only the title.

**Tech Stack:** Bun, TypeScript (strict), Express 5, SQLite (`bun:sqlite`), React 19, Vite. Tests are `bun test` (`*.test.ts` colocated with source).

## Global Constraints

- **There is no Twitch API to block incoming raids.** This feature signals; it never claims to prevent. Do not add a Shield Mode call, a `gql.twitch.tv` call, or anything that implies prevention. See `docs/superpowers/specs/2026-07-19-stream-wind-down-design.md`.
- **Raid alerts are never suppressed.** A raid during wind-down celebrates exactly as it normally would. Do not add a toggle for this.
- No new OAuth scopes. Everything uses `channel:manage:broadcast`, already in `REQUIRED_TWITCH_OAUTH_SCOPES` (`src/server/twitch/auth.ts:18`).
- Two-space indentation. No linter or formatter is configured — match surrounding code.
- TypeScript strict mode. React components PascalCase, hooks `useCamelCase`, CSS classes kebab-case.
- Shared client/server contracts go in `src/shared/api.ts`. Never duplicate a payload interface.
- Twitch title maximum is **140 characters**.
- Commits use semantic prefixes: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`.
- Never write to `data/streamer-tools.sqlite`. `bun test` sets `NODE_ENV=test`, which makes the DB in-memory (`src/server/db.ts:9-17`). Never verify against the real DB from an ad-hoc script.

## Deviation from the spec (deliberate)

The spec put the four configuration values in `app_config`. **This plan puts them in their own `wind_down_settings` table instead.** Adding one key to `app_config` requires edits at ~10 sites in `src/server/appConfig.ts` (internal type, row type, select, insert-seed, update, seed call, load, accessor, `toPublic`, `normalizeUpdate`, `saveAppConfig`, change detection) — four keys would be roughly forty edits to the module that owns credentials and drives service reconnects. `src/server/mediaMute.ts:12-15` documents staying off that path for the same reason, and `go_live_settings` / `tts_settings` are the established precedent for feature-owned settings tables. Behavior is identical; the blast radius is far smaller.

## File Structure

**Create:**
- `src/server/windDownTitle.ts` — pure title composition and suffix stripping. No imports from the app.
- `src/server/windDownTitle.test.ts`
- `src/server/windDown.ts` — settings + state persistence, REST routes, `winddown:updated` broadcast.
- `src/server/windDown.test.ts`
- `src/server/windDownSchedule.ts` — the pure `evaluateWindDown` decision.
- `src/server/windDownSchedule.test.ts`
- `src/server/windDownLoop.ts` — the tick loop, Twitch title application, boot reconciliation.
- `src/server/windDownLoop.test.ts`
- `src/client/windDown.ts` — `useWindDown` hook (operator) and `useWindDownOverlay` hook (browser source).
- `src/client/windDownCountdown.ts` — pure relative-time formatting for the countdown.
- `src/client/windDownCountdown.test.ts`
- `src/client/pages/settings/WindDownSection.tsx` — the Settings section.

**Modify:**
- `src/server/db.ts` — two new tables, one `addColumnIfMissing` for `stream_sessions.planned_end_at`.
- `src/server/streamSession.ts` — read/write `planned_end_at`.
- `src/server/auth.ts` — allowlist the event and the GET path.
- `src/server/auth.test.ts` — cover both.
- `src/server/index.ts` — register routes, start the loop.
- `src/server/actions.ts` — normalize the new step payload.
- `src/server/actionExecutor.ts` — dispatch the new step.
- `src/shared/api.ts` — all new contracts.
- `src/client/routing.ts` — the new overlay path and name.
- `src/client/routing.test.ts` — cover it.
- `src/client/main.tsx` — register the overlay component.
- `src/client/pages/Overlay.tsx` — the new overlay page.
- `src/client/pages/StreamInfoModal.tsx` — the planned-end field.
- `src/client/pages/Dashboard.tsx` — load/save planned end, mount the toggle.
- `src/client/ui/panels.tsx` — the wind-down toggle control.
- `src/client/services/dashboard.ts` — the new REST calls.
- `src/client/pages/settings/automation.ts` — step type list, label, `newStep`, `validateStep`.
- `src/client/pages/settings/ActionsPage.tsx` — the step editor branch.
- `src/client/pages/settings/sections.ts` — the new settings section.
- `src/client/pages/settings/SettingsShell.tsx` — render it.
- `src/client/styles/panel.css`, `src/client/styles.css` — control and overlay styling.
- `CLAUDE.md` — architecture map.

---

### Task 1: Title composition

The pure core. No app imports, so it tests instantly and the tricky truncation rule is settled before anything depends on it.

**Files:**
- Create: `src/server/windDownTitle.ts`
- Test: `src/server/windDownTitle.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `MAX_TWITCH_TITLE_LENGTH: 140`, `composeWindDownTitle(baseTitle: string, suffix: string): string`, `stripWindDownSuffix(title: string, suffix: string): string`.

- [ ] **Step 1: Write the failing test**

Create `src/server/windDownTitle.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { composeWindDownTitle, MAX_TWITCH_TITLE_LENGTH, stripWindDownSuffix } from './windDownTitle';

describe('composeWindDownTitle', () => {
  test('appends the suffix to the base title', () => {
    expect(composeWindDownTitle('Modding Skyrim', '| Ending soon')).toBe('Modding Skyrim | Ending soon');
  });

  test('trims surrounding whitespace on both parts', () => {
    expect(composeWindDownTitle('  Modding Skyrim  ', '  | Ending soon  ')).toBe('Modding Skyrim | Ending soon');
  });

  test('an empty suffix leaves the title untouched', () => {
    expect(composeWindDownTitle('Modding Skyrim', '   ')).toBe('Modding Skyrim');
  });

  test('an empty base title yields just the suffix', () => {
    expect(composeWindDownTitle('', '| Ending soon')).toBe('| Ending soon');
  });

  // Twitch rejects a title over 140 characters, and a rejected PATCH is a silent
  // no-op at exactly the moment the operator is counting on it. The suffix is the
  // entire point of the operation, so the base title is what yields.
  test('truncates the base title so the suffix always survives', () => {
    const base = 'A'.repeat(200);
    const result = composeWindDownTitle(base, '| Ending soon');
    expect(result.length).toBeLessThanOrEqual(MAX_TWITCH_TITLE_LENGTH);
    expect(result.endsWith('| Ending soon')).toBe(true);
    expect(result).toContain('…');
  });

  test('truncation prefers a word boundary', () => {
    const base = `${'word '.repeat(40)}tail`;
    const result = composeWindDownTitle(base, '| Ending soon');
    expect(result.length).toBeLessThanOrEqual(MAX_TWITCH_TITLE_LENGTH);
    expect(result).toContain('word… | Ending soon');
  });

  test('a suffix longer than the whole limit is hard-truncated rather than throwing', () => {
    const result = composeWindDownTitle('Base', 'X'.repeat(200));
    expect(result.length).toBe(MAX_TWITCH_TITLE_LENGTH);
  });

  test('a title exactly at the limit is left alone', () => {
    const suffix = '| Ending soon';
    const base = 'B'.repeat(MAX_TWITCH_TITLE_LENGTH - suffix.length - 1);
    const result = composeWindDownTitle(base, suffix);
    expect(result.length).toBe(MAX_TWITCH_TITLE_LENGTH);
    expect(result).toBe(`${base} ${suffix}`);
  });
});

describe('stripWindDownSuffix', () => {
  test('removes a suffix the operator edited around', () => {
    expect(stripWindDownSuffix('Modding Skyrim | Ending soon', '| Ending soon')).toBe('Modding Skyrim');
  });

  test('removes the truncation ellipsis along with the suffix', () => {
    expect(stripWindDownSuffix('Modding Skyrim… | Ending soon', '| Ending soon')).toBe('Modding Skyrim');
  });

  test('leaves a title that does not carry the suffix alone', () => {
    expect(stripWindDownSuffix('Modding Skyrim', '| Ending soon')).toBe('Modding Skyrim');
  });

  test('an empty suffix is a no-op', () => {
    expect(stripWindDownSuffix('Modding Skyrim', '')).toBe('Modding Skyrim');
  });

  test('a title that is only the suffix strips to empty', () => {
    expect(stripWindDownSuffix('| Ending soon', '| Ending soon')).toBe('');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/server/windDownTitle.test.ts`
Expected: FAIL — `Cannot find module './windDownTitle'`

- [ ] **Step 3: Write the implementation**

Create `src/server/windDownTitle.ts`:

```ts
/**
 * Composing the wind-down title, kept pure and dependency-free so the 140-character
 * rule is testable on its own.
 *
 * `base_title` in the wind_down_state row is always the operator's real title. The
 * live title is ALWAYS recomputed as base + suffix and never appended to whatever is
 * currently on the channel, so toggling wind-down twice cannot stack suffixes.
 */

/** Twitch's hard limit. A PATCH over this is rejected, and a rejected PATCH is silent. */
export const MAX_TWITCH_TITLE_LENGTH = 140;

/** Below this fraction of the available room, a word-boundary cut wastes too much. */
const WORD_BOUNDARY_MIN_RATIO = 0.6;

export function composeWindDownTitle(baseTitle: string, suffix: string): string {
  const base = baseTitle.trim();
  const tail = suffix.trim();
  if (!tail) return base;

  const combined = base ? `${base} ${tail}` : tail;
  if (combined.length <= MAX_TWITCH_TITLE_LENGTH) return combined;

  // Room left for the base once the separator space and the ellipsis are reserved.
  const room = MAX_TWITCH_TITLE_LENGTH - tail.length - 2;
  // A suffix that cannot fit at all: keep as much of it as Twitch will take. The
  // Settings form rejects this case up front; this is the belt-and-braces path.
  if (room <= 0) return tail.slice(0, MAX_TWITCH_TITLE_LENGTH);

  const cut = base.slice(0, room);
  const lastSpace = cut.lastIndexOf(' ');
  const trimmed = (lastSpace > room * WORD_BOUNDARY_MIN_RATIO ? cut.slice(0, lastSpace) : cut).trimEnd();
  return `${trimmed}… ${tail}`;
}

/**
 * Recover the operator's title from one that already carries the suffix.
 *
 * Needed when the operator edits the title mid-wind-down: they are editing the
 * suffixed title they can see, so their submission must be re-based rather than
 * stored verbatim, or the next compose would append a second suffix.
 */
export function stripWindDownSuffix(title: string, suffix: string): string {
  const value = title.trim();
  const tail = suffix.trim();
  if (!tail || !value.endsWith(tail)) return value;
  return value.slice(0, value.length - tail.length).trimEnd().replace(/…$/, '').trimEnd();
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/server/windDownTitle.test.ts`
Expected: PASS — 13 tests.

- [ ] **Step 5: Commit**

```bash
git add src/server/windDownTitle.ts src/server/windDownTitle.test.ts
git commit -m "feat: add wind-down title composition"
```

---

### Task 2: Schedule decision

The other pure piece. Encodes the "manual off must stick" latch, which is the rule most likely to be got wrong.

**Files:**
- Create: `src/server/windDownSchedule.ts`
- Test: `src/server/windDownSchedule.test.ts`
- Modify: `src/shared/api.ts` (append at the end of the file)

**Interfaces:**
- Consumes: nothing.
- Produces: `WindDownSource`, `WindDownSettings`, `WindDownPublicState` (in `src/shared/api.ts`); `evaluateWindDown(input): WindDownDecision`, `WindDownDecision`, `WindDownSchedulerState` (in `windDownSchedule.ts`). Note there is no type named `WindDownState`: the scheduler's narrow view is `WindDownSchedulerState` (this task) and the full stored row is `WindDownStoredState` (Task 4).

- [ ] **Step 1: Add the shared contracts**

Append to the end of `src/shared/api.ts`:

```ts
// --- Wind-down ---------------------------------------------------------------
// Signalling that the stream is wrapping up. Twitch exposes no way to block an
// incoming raid, so this tells a prospective raider rather than stopping them.

/** How a wind-down activation was triggered. */
export type WindDownSource = 'manual' | 'scheduled' | 'action';

/** GET/PUT /api/wind-down/settings. */
export type WindDownSettings = {
  /** Minutes before the planned end at which wind-down activates. 0 disables scheduling. */
  leadMinutes: number;
  /** Appended to the Twitch title while active. */
  titleSuffix: string;
  titleEnabled: boolean;
  overlayEnabled: boolean;
  updatedAt: string | null;
};

/**
 * The `winddown:updated` WebSocket payload and GET/PUT /api/wind-down body.
 *
 * Deliberately NOT the stored row: `baseTitle` and `dismissedSessionId` are operator
 * state and never go on the wire, because this event reaches overlay browser sources.
 */
export type WindDownPublicState = {
  active: boolean;
  source: WindDownSource | null;
  activatedAt: string | null;
  /** RFC3339, or null when no end time is planned. Drives the overlay countdown. */
  plannedEndAt: string | null;
  /** Whether the overlay should render at all — mirrors WindDownSettings.overlayEnabled. */
  overlayEnabled: boolean;
};
```

- [ ] **Step 2: Write the failing test**

Create `src/server/windDownSchedule.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { evaluateWindDown, type WindDownSchedulerState } from './windDownSchedule';

const AT_9PM = Date.parse('2026-07-19T21:00:00.000Z');
const MINUTE = 60_000;

const idle: WindDownSchedulerState = { active: false, dismissedSessionId: null };

function evaluate(overrides: Partial<Parameters<typeof evaluateWindDown>[0]> = {}) {
  return evaluateWindDown({
    now: AT_9PM - 20 * MINUTE,
    plannedEndAt: '2026-07-19T21:00:00.000Z',
    leadMinutes: 15,
    sessionId: 'session-1',
    state: idle,
    ...overrides,
  });
}

describe('evaluateWindDown', () => {
  test('does nothing before the lead window opens', () => {
    expect(evaluate({ now: AT_9PM - 20 * MINUTE }).action).toBe('none');
    expect(evaluate({ now: AT_9PM - 20 * MINUTE }).reason).toBe('before_window');
  });

  test('activates once the lead window is reached', () => {
    expect(evaluate({ now: AT_9PM - 15 * MINUTE })).toEqual({ action: 'activate', reason: 'lead_window_reached' });
  });

  test('activates inside the window', () => {
    expect(evaluate({ now: AT_9PM - 5 * MINUTE }).action).toBe('activate');
  });

  // Running over does not undo it: a stream past its planned end is still winding
  // down, and a restart at that point must still put the signal up.
  test('still activates after the planned end has passed', () => {
    expect(evaluate({ now: AT_9PM + 30 * MINUTE }).action).toBe('activate');
  });

  test('does nothing when already active', () => {
    const state: WindDownSchedulerState = { active: true, dismissedSessionId: null };
    expect(evaluate({ now: AT_9PM - 5 * MINUTE, state })).toEqual({ action: 'none', reason: 'already_active' });
  });

  // The rule that makes this feature usable. Turning wind-down off by hand because
  // the stream is continuing must not be undone by the very next tick.
  test('a manual dismissal latches for the rest of the session', () => {
    const state: WindDownSchedulerState = { active: false, dismissedSessionId: 'session-1' };
    expect(evaluate({ now: AT_9PM - 5 * MINUTE, state }))
      .toEqual({ action: 'none', reason: 'dismissed_this_session' });
  });

  test('a dismissal from a previous session does not latch the current one', () => {
    const state: WindDownSchedulerState = { active: false, dismissedSessionId: 'session-0' };
    expect(evaluate({ now: AT_9PM - 5 * MINUTE, state }).action).toBe('activate');
  });

  test('does nothing off-stream', () => {
    expect(evaluate({ now: AT_9PM - 5 * MINUTE, sessionId: null }))
      .toEqual({ action: 'none', reason: 'no_active_session' });
  });

  test('does nothing with no planned end', () => {
    expect(evaluate({ now: AT_9PM - 5 * MINUTE, plannedEndAt: null }))
      .toEqual({ action: 'none', reason: 'no_planned_end' });
  });

  test('an unparsable planned end is inert rather than throwing', () => {
    expect(evaluate({ now: AT_9PM, plannedEndAt: 'not a date' }))
      .toEqual({ action: 'none', reason: 'unparsable_planned_end' });
  });

  test('a zero or negative lead disables scheduling', () => {
    expect(evaluate({ now: AT_9PM, leadMinutes: 0 })).toEqual({ action: 'none', reason: 'lead_disabled' });
    expect(evaluate({ now: AT_9PM, leadMinutes: -5 })).toEqual({ action: 'none', reason: 'lead_disabled' });
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `bun test src/server/windDownSchedule.test.ts`
Expected: FAIL — `Cannot find module './windDownSchedule'`

- [ ] **Step 4: Write the implementation**

Create `src/server/windDownSchedule.ts`:

```ts
/**
 * Pure decision logic for the wind-down loop, extracted so it can be tested without
 * timers, a database, or network — the same split as `evaluateAdSchedule`. The caller
 * loads the state and settings, and owns the actual activation.
 */

/** Only the fields of the stored row the decision depends on. */
export type WindDownSchedulerState = {
  active: boolean;
  /** The session the operator manually turned wind-down off during, if any. */
  dismissedSessionId: string | null;
};

export type WindDownDecision = {
  action: 'activate' | 'none';
  /** Machine-readable, for logs and tests. */
  reason: string;
};

const MS_PER_MINUTE = 60_000;

export function evaluateWindDown(input: {
  now: number;
  plannedEndAt: string | null;
  leadMinutes: number;
  sessionId: string | null;
  state: WindDownSchedulerState;
}): WindDownDecision {
  const { now, plannedEndAt, leadMinutes, sessionId, state } = input;

  if (state.active) return { action: 'none', reason: 'already_active' };
  if (!sessionId) return { action: 'none', reason: 'no_active_session' };

  // The operator turned it off by hand during this session. Honour that for the rest
  // of the stream: re-arming on the next tick makes the off switch useless, which is
  // worse than never having scheduled it.
  if (state.dismissedSessionId === sessionId) {
    return { action: 'none', reason: 'dismissed_this_session' };
  }

  if (!plannedEndAt) return { action: 'none', reason: 'no_planned_end' };
  if (leadMinutes <= 0) return { action: 'none', reason: 'lead_disabled' };

  const endMs = new Date(plannedEndAt).getTime();
  if (!Number.isFinite(endMs)) return { action: 'none', reason: 'unparsable_planned_end' };

  // No upper bound on purpose. Past the planned end the stream is still winding down,
  // so a late boot or a stream running over must still raise the signal.
  if (now < endMs - leadMinutes * MS_PER_MINUTE) return { action: 'none', reason: 'before_window' };

  return { action: 'activate', reason: 'lead_window_reached' };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test src/server/windDownSchedule.test.ts`
Expected: PASS — 11 tests.

- [ ] **Step 6: Typecheck and commit**

```bash
bun run typecheck
git add src/server/windDownSchedule.ts src/server/windDownSchedule.test.ts src/shared/api.ts
git commit -m "feat: add the wind-down schedule decision"
```

---

### Task 3: Planned end time on the stream session

**Files:**
- Modify: `src/server/db.ts` (the `addColumnIfMissing` block near line 601)
- Modify: `src/server/streamSession.ts`
- Test: `src/server/streamSession.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `StreamSession.plannedEndAt: string | null`; `setPlannedStreamEnd(sessionId: string, plannedEndAt: string | null): void`; `getPlannedStreamEnd(): string | null`.

- [ ] **Step 1: Write the failing test**

Create `src/server/streamSession.test.ts`:

```ts
import { beforeEach, describe, expect, test } from 'bun:test';
import { db } from './db';
import {
  endActiveStreamSession,
  getActiveStreamSession,
  getOrStartStreamSession,
  getPlannedStreamEnd,
  setPlannedStreamEnd,
} from './streamSession';

beforeEach(() => {
  db.exec('delete from stream_session_chatters');
  db.exec('delete from stream_sessions');
});

describe('planned stream end', () => {
  test('a new session has no planned end', () => {
    getOrStartStreamSession('test-a', '2026-07-19T18:00:00.000Z');
    expect(getPlannedStreamEnd()).toBeNull();
    expect(getActiveStreamSession()?.plannedEndAt).toBeNull();
  });

  test('stores and reads back a planned end', () => {
    const session = getOrStartStreamSession('test-b', '2026-07-19T18:00:00.000Z');
    setPlannedStreamEnd(session.id, '2026-07-19T21:00:00.000Z');
    expect(getPlannedStreamEnd()).toBe('2026-07-19T21:00:00.000Z');
  });

  test('clears a planned end', () => {
    const session = getOrStartStreamSession('test-c', '2026-07-19T18:00:00.000Z');
    setPlannedStreamEnd(session.id, '2026-07-19T21:00:00.000Z');
    setPlannedStreamEnd(session.id, null);
    expect(getPlannedStreamEnd()).toBeNull();
  });

  // The plan belongs to one stream. Ending the session must not leak it into the next.
  test('a planned end does not survive the session ending', () => {
    const session = getOrStartStreamSession('test-d', '2026-07-19T18:00:00.000Z');
    setPlannedStreamEnd(session.id, '2026-07-19T21:00:00.000Z');
    endActiveStreamSession('2026-07-19T21:30:00.000Z');
    expect(getPlannedStreamEnd()).toBeNull();
  });

  test('off-stream, there is no planned end to read', () => {
    expect(getPlannedStreamEnd()).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/server/streamSession.test.ts`
Expected: FAIL — `getPlannedStreamEnd is not a function` (or an export error).

- [ ] **Step 3: Add the column**

In `src/server/db.ts`, in the `addColumnIfMissing` block (immediately after the line `addColumnIfMissing('chat_messages', 'is_first_ever', 'integer not null default 0');`), add:

```ts
// When the operator plans to end this stream, set from the go-live Info screen or
// the dashboard. Null for sessions with no plan and for rows predating the column.
addColumnIfMissing('stream_sessions', 'planned_end_at', 'text');
```

- [ ] **Step 4: Read and write the column**

In `src/server/streamSession.ts`, add `plannedEndAt` to the `StreamSession` type (after `discordAnnounceTerminal: number;`):

```ts
  /** RFC3339 time the operator plans to end this stream, or null. */
  plannedEndAt: string | null;
```

Add `planned_end_at as plannedEndAt,` to the select list of **both** `getActiveSessionRow` and `getSessionBySourceRow`, immediately after `discord_announce_terminal as discordAnnounceTerminal`. Note that in both statements the preceding line then needs a trailing comma. The `getActiveSessionRow` select list becomes:

```ts
const getActiveSessionRow = db.prepare(`
  select
    id,
    started_at as startedAt,
    ended_at as endedAt,
    source,
    discord_message_id as discordMessageId,
    discord_channel_id as discordChannelId,
    discord_announce_error as discordAnnounceError,
    discord_announce_attempts as discordAnnounceAttempts,
    discord_announce_terminal as discordAnnounceTerminal,
    planned_end_at as plannedEndAt
  from stream_sessions
  where ended_at is null
  order by started_at desc
  limit 1
`);
```

and `getSessionBySourceRow` likewise:

```ts
const getSessionBySourceRow = db.prepare(`
  select
    id,
    started_at as startedAt,
    ended_at as endedAt,
    source,
    discord_message_id as discordMessageId,
    discord_channel_id as discordChannelId,
    discord_announce_error as discordAnnounceError,
    discord_announce_attempts as discordAnnounceAttempts,
    discord_announce_terminal as discordAnnounceTerminal,
    planned_end_at as plannedEndAt
  from stream_sessions
  where source = ?
  limit 1
`);
```

Add the prepared statement after `clearStreamSessionAnnounceError`:

```ts
const updateStreamSessionPlannedEnd = db.prepare(`
  update stream_sessions
  set planned_end_at = ?
  where id = ?
`);
```

Add the two functions at the end of the file:

```ts
/**
 * The plan is scoped to one stream. `getPlannedStreamEnd` reads the ACTIVE session
 * only, so ending a session drops the plan rather than carrying it into the next one.
 */
export function setPlannedStreamEnd(sessionId: string, plannedEndAt: string | null) {
  updateStreamSessionPlannedEnd.run(plannedEndAt, sessionId);
}

export function getPlannedStreamEnd(): string | null {
  return getActiveStreamSession()?.plannedEndAt ?? null;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test src/server/streamSession.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 6: Run the whole suite and commit**

```bash
bun test
bun run typecheck
git add src/server/db.ts src/server/streamSession.ts src/server/streamSession.test.ts
git commit -m "feat: record a planned end time on the stream session"
```

---

### Task 4: Wind-down settings and state store

**Files:**
- Modify: `src/server/db.ts` (schema block)
- Create: `src/server/windDown.ts`
- Test: `src/server/windDown.test.ts`

**Interfaces:**
- Consumes: `WindDownSettings`, `WindDownPublicState`, `WindDownSource` from `src/shared/api.ts` (Task 2); `getPlannedStreamEnd`, `getCurrentStreamSessionId` from `./streamSession` (Task 3); `MAX_TWITCH_TITLE_LENGTH` from `./windDownTitle` (Task 1).
- Produces: `getWindDownSettings()`, `saveWindDownSettings(body: unknown): WindDownSettings`, `getWindDownState(): WindDownStoredState`, `getWindDownPublicState(): WindDownPublicState`, `setWindDownActive(input): WindDownPublicState`, `setWindDownBaseTitle(baseTitle: string | null): void`, `rebaseWindDownTitle(submittedTitle: string): string`, `broadcastWindDown(): void`, `registerWindDownRoutes(app)`, and the type `WindDownStoredState`.

- [ ] **Step 1: Add the schema**

In `src/server/db.ts`, immediately after the `create table if not exists media_mute (...)` block (around line 352), add:

```sql
  -- Wind-down configuration. Its own table rather than app_config: these are
  -- feature settings, not credentials, and saving them must never reconnect Twitch
  -- or OBS. Same shape as go_live_settings.
  create table if not exists wind_down_settings (
    id text primary key,
    lead_minutes integer not null default 15,
    title_suffix text not null default '| Ending soon',
    title_enabled integer not null default 1,
    overlay_enabled integer not null default 1,
    updated_at text not null
  );

  -- Wind-down runtime state. Single row (id = 1) so it survives a restart.
  --
  -- base_title is PERSISTED, not held in memory: a restart while active would
  -- otherwise leave the suffix welded to the operator's Twitch title into the next
  -- stream, with nothing left that knows what the title used to be.
  --
  -- dismissed_session_id latches a manual switch-off for the rest of that stream, so
  -- the scheduler cannot re-arm one tick after the operator decided to keep going.
  create table if not exists wind_down_state (
    id integer primary key check (id = 1),
    active integer not null default 0,
    activated_at text,
    source text,
    session_id text,
    base_title text,
    dismissed_session_id text
  );
```

- [ ] **Step 2: Write the failing test**

Create `src/server/windDown.test.ts`:

```ts
import { beforeEach, describe, expect, test } from 'bun:test';
import { db } from './db';
import { getOrStartStreamSession, setPlannedStreamEnd } from './streamSession';
import {
  getWindDownPublicState,
  getWindDownSettings,
  getWindDownState,
  rebaseWindDownTitle,
  saveWindDownSettings,
  setWindDownActive,
  setWindDownBaseTitle,
} from './windDown';

beforeEach(() => {
  db.exec('delete from wind_down_state');
  db.exec('delete from wind_down_settings');
  db.exec('delete from stream_session_chatters');
  db.exec('delete from stream_sessions');
});

describe('wind-down settings', () => {
  test('a fresh install gets the documented defaults', () => {
    const settings = getWindDownSettings();
    expect(settings.leadMinutes).toBe(15);
    expect(settings.titleSuffix).toBe('| Ending soon');
    expect(settings.titleEnabled).toBe(true);
    expect(settings.overlayEnabled).toBe(true);
  });

  test('saves and reads back', () => {
    saveWindDownSettings({ leadMinutes: 30, titleSuffix: '| Wrapping up', titleEnabled: false, overlayEnabled: true });
    const settings = getWindDownSettings();
    expect(settings.leadMinutes).toBe(30);
    expect(settings.titleSuffix).toBe('| Wrapping up');
    expect(settings.titleEnabled).toBe(false);
  });

  test('clamps an absurd lead time rather than storing it', () => {
    saveWindDownSettings({ leadMinutes: 99_999, titleSuffix: 'x', titleEnabled: true, overlayEnabled: true });
    expect(getWindDownSettings().leadMinutes).toBe(720);
    saveWindDownSettings({ leadMinutes: -10, titleSuffix: 'x', titleEnabled: true, overlayEnabled: true });
    expect(getWindDownSettings().leadMinutes).toBe(0);
  });

  // A suffix that cannot fit inside Twitch's 140 characters would make every title
  // update fail. Reject it here, in the form, rather than at 9pm.
  test('rejects a suffix that could never fit a Twitch title', () => {
    expect(() => saveWindDownSettings({
      leadMinutes: 15,
      titleSuffix: 'X'.repeat(200),
      titleEnabled: true,
      overlayEnabled: true,
    })).toThrow();
  });
});

describe('wind-down state', () => {
  test('starts inactive', () => {
    expect(getWindDownPublicState().active).toBe(false);
    expect(getWindDownPublicState().source).toBeNull();
  });

  test('activating records the source and session', () => {
    const session = getOrStartStreamSession('test-a', '2026-07-19T18:00:00.000Z');
    const state = setWindDownActive({ active: true, source: 'manual' });
    expect(state.active).toBe(true);
    expect(state.source).toBe('manual');
    expect(getWindDownState().sessionId).toBe(session.id);
  });

  test('the public state carries the planned end for the overlay countdown', () => {
    const session = getOrStartStreamSession('test-b', '2026-07-19T18:00:00.000Z');
    setPlannedStreamEnd(session.id, '2026-07-19T21:00:00.000Z');
    expect(getWindDownPublicState().plannedEndAt).toBe('2026-07-19T21:00:00.000Z');
  });

  // The public payload rides an overlay-visible WebSocket event. Operator state must
  // not be on it.
  test('the public state never exposes the stored base title', () => {
    setWindDownBaseTitle('Modding Skyrim');
    expect(Object.keys(getWindDownPublicState())).not.toContain('baseTitle');
    expect(JSON.stringify(getWindDownPublicState())).not.toContain('Modding Skyrim');
  });

  test('turning it off by hand latches the dismissal to the current session', () => {
    const session = getOrStartStreamSession('test-c', '2026-07-19T18:00:00.000Z');
    setWindDownActive({ active: true, source: 'scheduled' });
    setWindDownActive({ active: false, source: 'manual' });
    expect(getWindDownState().active).toBe(false);
    expect(getWindDownState().dismissedSessionId).toBe(session.id);
  });

  // Only a manual switch-off is a decision to keep streaming. An Action or the
  // scheduler turning it off must not stop the schedule from arming again.
  test('a non-manual switch-off does not latch a dismissal', () => {
    getOrStartStreamSession('test-d', '2026-07-19T18:00:00.000Z');
    setWindDownActive({ active: true, source: 'scheduled' });
    setWindDownActive({ active: false, source: 'action' });
    expect(getWindDownState().dismissedSessionId).toBeNull();
  });

  test('activating again clears a stale dismissal', () => {
    getOrStartStreamSession('test-e', '2026-07-19T18:00:00.000Z');
    setWindDownActive({ active: true, source: 'manual' });
    setWindDownActive({ active: false, source: 'manual' });
    setWindDownActive({ active: true, source: 'manual' });
    expect(getWindDownState().dismissedSessionId).toBeNull();
  });

  test('the base title round-trips through storage', () => {
    setWindDownBaseTitle('Modding Skyrim');
    expect(getWindDownState().baseTitle).toBe('Modding Skyrim');
    setWindDownBaseTitle(null);
    expect(getWindDownState().baseTitle).toBeNull();
  });
});

describe('rebaseWindDownTitle', () => {
  // The operator edits the title they can SEE, which already carries the suffix.
  // Storing that verbatim would double the suffix on the next compose.
  test('re-bases an edit made against the suffixed title', () => {
    getOrStartStreamSession('test-f', '2026-07-19T18:00:00.000Z');
    setWindDownActive({ active: true, source: 'manual' });
    setWindDownBaseTitle('Modding Skyrim');
    const live = rebaseWindDownTitle('Modding Fallout | Ending soon');
    expect(getWindDownState().baseTitle).toBe('Modding Fallout');
    expect(live).toBe('Modding Fallout | Ending soon');
  });

  test('re-bases an edit made without the suffix', () => {
    getOrStartStreamSession('test-g', '2026-07-19T18:00:00.000Z');
    setWindDownActive({ active: true, source: 'manual' });
    setWindDownBaseTitle('Modding Skyrim');
    const live = rebaseWindDownTitle('Modding Fallout');
    expect(getWindDownState().baseTitle).toBe('Modding Fallout');
    expect(live).toBe('Modding Fallout | Ending soon');
  });

  test('passes the title straight through when wind-down is off', () => {
    expect(rebaseWindDownTitle('Modding Fallout')).toBe('Modding Fallout');
    expect(getWindDownState().baseTitle).toBeNull();
  });

  test('leaves the title alone when the title effect is disabled', () => {
    getOrStartStreamSession('test-h', '2026-07-19T18:00:00.000Z');
    saveWindDownSettings({ leadMinutes: 15, titleSuffix: '| Ending soon', titleEnabled: false, overlayEnabled: true });
    setWindDownActive({ active: true, source: 'manual' });
    expect(rebaseWindDownTitle('Modding Fallout')).toBe('Modding Fallout');
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `bun test src/server/windDown.test.ts`
Expected: FAIL — `Cannot find module './windDown'`

- [ ] **Step 4: Write the implementation**

Create `src/server/windDown.ts`:

```ts
import type express from 'express';
import type { WindDownPublicState, WindDownSettings, WindDownSource } from '../shared/api';
import { db } from './db';
import { handle, HttpRouteError } from './http';
import { clampFinite } from './numeric';
import { broadcast } from './realtime';
import { getCurrentStreamSessionId, getPlannedStreamEnd } from './streamSession';
import { composeWindDownTitle, MAX_TWITCH_TITLE_LENGTH, stripWindDownSuffix } from './windDownTitle';

/**
 * Wind-down: the switch that says "this stream is wrapping up". Twitch exposes no
 * way to block an incoming raid, so this signals a prospective raider through the
 * channel title and an overlay countdown rather than preventing anything.
 *
 * Settings and state are separate rows for separate reasons: settings are operator
 * configuration edited in Settings, state is runtime and must survive a restart.
 */

const SETTINGS_ID = 'default';

/** Twelve hours. Beyond this a "lead time" is not a lead time. */
const MAX_LEAD_MINUTES = 720;
const MAX_SUFFIX_LENGTH = 60;

const DEFAULT_SETTINGS = {
  leadMinutes: 15,
  titleSuffix: '| Ending soon',
  titleEnabled: true,
  overlayEnabled: true,
} as const;

/** The stored row, including the fields that must never reach a browser source. */
export type WindDownStoredState = {
  active: boolean;
  activatedAt: string | null;
  source: WindDownSource | null;
  sessionId: string | null;
  baseTitle: string | null;
  dismissedSessionId: string | null;
};

type SettingsRow = {
  leadMinutes: number;
  titleSuffix: string;
  titleEnabled: number;
  overlayEnabled: number;
  updatedAt: string;
};

type StateRow = {
  active: number;
  activatedAt: string | null;
  source: string | null;
  sessionId: string | null;
  baseTitle: string | null;
  dismissedSessionId: string | null;
};

const selectSettings = db.prepare(`
  select
    lead_minutes as leadMinutes,
    title_suffix as titleSuffix,
    title_enabled as titleEnabled,
    overlay_enabled as overlayEnabled,
    updated_at as updatedAt
  from wind_down_settings
  where id = ?
`);

const seedSettings = db.prepare(`
  insert or ignore into wind_down_settings
    (id, lead_minutes, title_suffix, title_enabled, overlay_enabled, updated_at)
  values (?, ?, ?, ?, ?, ?)
`);

const updateSettings = db.prepare(`
  update wind_down_settings set
    lead_minutes = ?,
    title_suffix = ?,
    title_enabled = ?,
    overlay_enabled = ?,
    updated_at = ?
  where id = ?
`);

const selectState = db.prepare(`
  select
    active,
    activated_at as activatedAt,
    source,
    session_id as sessionId,
    base_title as baseTitle,
    dismissed_session_id as dismissedSessionId
  from wind_down_state
  where id = 1
`);

const upsertState = db.prepare(`
  insert into wind_down_state (id, active, activated_at, source, session_id, base_title, dismissed_session_id)
  values (1, ?, ?, ?, ?, ?, ?)
  on conflict(id) do update set
    active = excluded.active,
    activated_at = excluded.activated_at,
    source = excluded.source,
    session_id = excluded.session_id,
    base_title = excluded.base_title,
    dismissed_session_id = excluded.dismissed_session_id
`);

function nowIso(): string {
  return new Date().toISOString();
}

function seedSettingsIfMissing() {
  seedSettings.run(
    SETTINGS_ID,
    DEFAULT_SETTINGS.leadMinutes,
    DEFAULT_SETTINGS.titleSuffix,
    DEFAULT_SETTINGS.titleEnabled ? 1 : 0,
    DEFAULT_SETTINGS.overlayEnabled ? 1 : 0,
    nowIso(),
  );
}

export function getWindDownSettings(): WindDownSettings {
  seedSettingsIfMissing();
  const row = selectSettings.get(SETTINGS_ID) as SettingsRow;
  return {
    leadMinutes: row.leadMinutes,
    titleSuffix: row.titleSuffix,
    titleEnabled: row.titleEnabled === 1,
    overlayEnabled: row.overlayEnabled === 1,
    updatedAt: row.updatedAt || null,
  };
}

export function saveWindDownSettings(body: unknown): WindDownSettings {
  const value = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const prev = getWindDownSettings();

  const leadMinutes = value.leadMinutes !== undefined
    ? Math.round(clampFinite(Number(value.leadMinutes), 0, MAX_LEAD_MINUTES, DEFAULT_SETTINGS.leadMinutes))
    : prev.leadMinutes;

  const titleSuffix = value.titleSuffix !== undefined
    ? String(value.titleSuffix).trim().slice(0, MAX_SUFFIX_LENGTH)
    : prev.titleSuffix;

  // A suffix with no room left for a title would make every wind-down title update
  // fail with a 400 the operator would never see. Refuse it here instead.
  if (titleSuffix.length >= MAX_TWITCH_TITLE_LENGTH) {
    throw new HttpRouteError(400, `The title suffix must be shorter than ${MAX_TWITCH_TITLE_LENGTH} characters.`);
  }

  const titleEnabled = value.titleEnabled !== undefined ? value.titleEnabled === true : prev.titleEnabled;
  const overlayEnabled = value.overlayEnabled !== undefined ? value.overlayEnabled === true : prev.overlayEnabled;

  updateSettings.run(
    leadMinutes,
    titleSuffix,
    titleEnabled ? 1 : 0,
    overlayEnabled ? 1 : 0,
    nowIso(),
    SETTINGS_ID,
  );
  return getWindDownSettings();
}

export function getWindDownState(): WindDownStoredState {
  const row = selectState.get() as StateRow | null;
  if (!row) {
    return { active: false, activatedAt: null, source: null, sessionId: null, baseTitle: null, dismissedSessionId: null };
  }
  return {
    active: row.active === 1,
    activatedAt: row.activatedAt,
    source: (row.source as WindDownSource | null) ?? null,
    sessionId: row.sessionId,
    baseTitle: row.baseTitle,
    dismissedSessionId: row.dismissedSessionId,
  };
}

function writeState(state: WindDownStoredState) {
  upsertState.run(
    state.active ? 1 : 0,
    state.activatedAt,
    state.source,
    state.sessionId,
    state.baseTitle,
    state.dismissedSessionId,
  );
}

/**
 * What goes on the wire. `baseTitle`, `sessionId`, and `dismissedSessionId` are
 * deliberately absent: `winddown:updated` is on the overlay allowlist, and a browser
 * source has no business seeing the operator's stored title.
 */
export function getWindDownPublicState(): WindDownPublicState {
  const state = getWindDownState();
  const settings = getWindDownSettings();
  return {
    active: state.active,
    source: state.source,
    activatedAt: state.activatedAt,
    plannedEndAt: getPlannedStreamEnd(),
    overlayEnabled: settings.overlayEnabled,
  };
}

export function broadcastWindDown() {
  broadcast('winddown:updated', getWindDownPublicState());
}

export function setWindDownActive(input: { active: boolean; source: WindDownSource }): WindDownPublicState {
  const prev = getWindDownState();
  const sessionId = getCurrentStreamSessionId();

  // Only a MANUAL switch-off is the operator deciding to keep streaming, and only
  // that latches. An Action or the scheduler turning it off leaves the schedule free
  // to arm again.
  const dismissedSessionId = input.active
    ? null
    : input.source === 'manual' && sessionId
      ? sessionId
      : prev.dismissedSessionId;

  writeState({
    active: input.active,
    activatedAt: input.active ? (prev.active ? prev.activatedAt : nowIso()) : null,
    source: input.active ? input.source : null,
    sessionId: input.active ? sessionId : prev.sessionId,
    // The base title is owned by the loop, which restores from it. Preserve it here.
    baseTitle: prev.baseTitle,
    dismissedSessionId,
  });

  const state = getWindDownPublicState();
  broadcast('winddown:updated', state);
  return state;
}

/** The loop's handle on the stored pre-wind-down title. */
export function setWindDownBaseTitle(baseTitle: string | null) {
  writeState({ ...getWindDownState(), baseTitle });
}

/**
 * Re-base a title the operator submitted while wind-down is active.
 *
 * They are editing the suffixed title they can SEE, so storing their submission
 * verbatim would make the next compose append a second suffix. Returns what should
 * actually be sent to Twitch.
 *
 * Lives here rather than in windDownLoop.ts on purpose: twitch/api.ts calls this, and
 * windDownLoop.ts imports twitch/api.ts, so putting it there would make a cycle
 * between two modules that both prepare statements at load time.
 */
export function rebaseWindDownTitle(submittedTitle: string): string {
  const state = getWindDownState();
  if (!state.active) return submittedTitle;

  const settings = getWindDownSettings();
  if (!settings.titleEnabled) return submittedTitle;

  const base = stripWindDownSuffix(submittedTitle, settings.titleSuffix);
  setWindDownBaseTitle(base);
  return composeWindDownTitle(base, settings.titleSuffix);
}

/**
 * The GET is on the overlay token's read allowlist so a browser source can seed
 * itself. The PUT is operator-only — the overlay token is GET-only by construction,
 * so a browser source cannot switch wind-down on for the whole channel.
 */
export function registerWindDownRoutes(app: express.Express) {
  app.get('/api/wind-down', (_request, response) => {
    response.json(getWindDownPublicState());
  });

  app.put('/api/wind-down', handle((request, response) => {
    const active = (request.body as { active?: unknown } | null)?.active === true;
    response.json(setWindDownActive({ active, source: 'manual' }));
  }));

  app.get('/api/wind-down/settings', (_request, response) => {
    response.json(getWindDownSettings());
  });

  app.put('/api/wind-down/settings', handle((request, response) => {
    response.json(saveWindDownSettings(request.body));
  }));
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test src/server/windDown.test.ts`
Expected: PASS — 16 tests.

- [ ] **Step 6: Register the routes**

In `src/server/index.ts`, add the import next to the other route imports (near line 18, alongside `import { registerMediaMuteRoutes } from './mediaMute';`):

```ts
import { registerWindDownRoutes } from './windDown';
```

And in the registration block, immediately after `registerMediaMuteRoutes(app);`:

```ts
registerWindDownRoutes(app);
```

- [ ] **Step 7: Verify and commit**

```bash
bun test
bun run typecheck
git add src/server/db.ts src/server/windDown.ts src/server/windDown.test.ts src/server/index.ts
git commit -m "feat: add the wind-down settings and state store"
```

---

### Task 5: Overlay allowlists

Small but security-relevant, and it gets its own reviewer gate for that reason.

**Files:**
- Modify: `src/server/auth.ts`
- Test: `src/server/auth.test.ts`

**Interfaces:**
- Consumes: the `/api/wind-down` routes from Task 4.
- Produces: nothing new; `isOverlayEvent('winddown:updated') === true` and `/api/wind-down` readable by the overlay token.

- [ ] **Step 1: Write the failing test**

In `src/server/auth.test.ts`, inside the existing `describe('overlay event scope', ...)` block, add:

```ts
  // The countdown overlay is a browser source and cannot authenticate, so it must be
  // able to receive this. The payload carries no operator configuration — see
  // getWindDownPublicState.
  test('overlay connections receive wind-down updates', () => {
    expect(isOverlayEvent('winddown:updated')).toBe(true);
  });
```

And in the existing `describe('requireDashboardToken', ...)` block, add:

```ts
  test('lets the overlay token read wind-down state', () => {
    setToken(OPERATOR);
    const call = callMiddleware({ path: '/api/wind-down', token: getOverlayToken()! });
    expect(call.nextCalled).toBe(true);
  });

  // A browser source that could PUT here would switch wind-down on for every other
  // source and rewrite the operator's Twitch title.
  test('blocks the overlay token from switching wind-down on', () => {
    setToken(OPERATOR);
    const call = callMiddleware({ method: 'PUT', path: '/api/wind-down', token: getOverlayToken()! });
    expect(call.status).toBe(403);
    expect(call.nextCalled).toBe(false);
  });

  test('blocks the overlay token from reading wind-down settings', () => {
    setToken(OPERATOR);
    const call = callMiddleware({ path: '/api/wind-down/settings', token: getOverlayToken()! });
    expect(call.status).toBe(403);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/server/auth.test.ts`
Expected: FAIL — the wind-down event test fails (`expected true, got false`) and the overlay-read test fails with 403.

- [ ] **Step 3: Add to the allowlists**

In `src/server/auth.ts`, add to `OVERLAY_PATHS`, after the `'/api/overlay/placeholders',` entry:

```ts
  // The countdown overlay seeds itself from this. GET only by the rule above, so a
  // browser source can read that the stream is winding down but never declare it.
  // /api/wind-down/settings is deliberately absent — it is operator configuration.
  '/api/wind-down',
```

And to `OVERLAY_EVENTS`, after the `'overlay:placeholders',` entry:

```ts
  // An active flag, a source, and the planned end time — no operator configuration.
  // The stored base title is deliberately not on this payload.
  'winddown:updated',
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/server/auth.test.ts`
Expected: PASS — all tests including the four new ones.

- [ ] **Step 5: Commit**

```bash
git add src/server/auth.ts src/server/auth.test.ts
git commit -m "feat: let overlay sources read wind-down state"
```

---

### Task 6: The wind-down loop

Where the title actually changes. The restart-reconciliation path is the important part.

**Files:**
- Create: `src/server/windDownLoop.ts`
- Test: `src/server/windDownLoop.test.ts`
- Modify: `src/server/index.ts`

**Interfaces:**
- Consumes: `evaluateWindDown` (Task 2), `getPlannedStreamEnd`/`getCurrentStreamSessionId` (Task 3), `getWindDownSettings`/`getWindDownState`/`setWindDownActive`/`setWindDownBaseTitle`/`broadcastWindDown` (Task 4), `composeWindDownTitle`/`stripWindDownSuffix` (Task 1).
- Produces: `applyWindDownTitle(port, active): Promise<void>`, `reconcileWindDownOnBoot(port): Promise<void>`, `startWindDownLoop(state: RuntimeState): void`, `windDownTitlePort(state: RuntimeState): WindDownTitlePort`, `WindDownTitlePort`.
- Also produces (in `windDown.ts`, not this module): `rebaseWindDownTitle(submittedTitle: string): string`.

> **Import direction matters here.** `windDownLoop.ts` imports from `twitch/api.ts`, so `twitch/api.ts` must NOT import from `windDownLoop.ts` — that is a cycle, and both modules run `db.prepare` at load time, so a cycle would be a boot-order landmine rather than a clean error. `rebaseWindDownTitle` therefore lives in `windDown.ts`, which imports no Twitch code. The dependency order is: `twitch/api.ts` → `windDown.ts` → `windDownTitle.ts`, and separately `windDownLoop.ts` → both `twitch/api.ts` and `windDown.ts`.

- [ ] **Step 1: Add the Twitch title call**

In `src/server/twitch/api.ts`, add this exported function immediately before `export function registerTwitchApiRoutes(` (around line 637):

```ts
/**
 * Set ONLY the channel title.
 *
 * Deliberately not routed through PATCH /api/twitch/stream-info: that route requires
 * a category alongside the title and calls onCategorySignal on every success, so a
 * wind-down title tweak would re-fire category-module switching as a side effect of
 * the clock reaching a number. Twitch accepts a partial channel update, so send only
 * what is actually changing.
 */
export async function setTwitchChannelTitle(state: RuntimeState, title: string): Promise<void> {
  const credentials = await getTwitchActionCredentials(state, ['channel:manage:broadcast']);
  await twitchFetch(
    `https://api.twitch.tv/helix/channels?broadcaster_id=${encodeURIComponent(credentials.broadcasterId)}`,
    {
      credentials,
      method: 'PATCH',
      body: { title },
      errorMessage: 'Twitch channel title update failed.',
    },
  );
}

/** The channel's current title, for capturing a base title before wind-down edits it. */
export async function getTwitchChannelTitle(state: RuntimeState): Promise<string> {
  const credentials = await getTwitchActionCredentials(state, []);
  const res = await twitchFetch(
    `https://api.twitch.tv/helix/channels?broadcaster_id=${encodeURIComponent(credentials.broadcasterId)}`,
    { credentials, errorMessage: 'Twitch channel information is unavailable.' },
  );
  const data = await res.json() as { data?: Array<{ title?: string }> };
  return data.data?.[0]?.title ?? '';
}
```

- [ ] **Step 2: Write the failing test**

Create `src/server/windDownLoop.test.ts`:

```ts
import { beforeEach, describe, expect, test } from 'bun:test';
import { db } from './db';
import { getOrStartStreamSession } from './streamSession';
import { getWindDownState, saveWindDownSettings, setWindDownActive } from './windDown';
import { applyWindDownTitle, reconcileWindDownOnBoot, type WindDownTitlePort } from './windDownLoop';

/** A fake Twitch channel whose title we can read back. */
function fakePort(initialTitle: string) {
  const port = {
    title: initialTitle,
    reads: 0,
    writes: [] as string[],
    failNextWrite: false,
    port: null as unknown as WindDownTitlePort,
  };
  port.port = {
    getTitle: async () => { port.reads += 1; return port.title; },
    setTitle: async (next: string) => {
      if (port.failNextWrite) { port.failNextWrite = false; throw new Error('Twitch is down'); }
      port.title = next;
      port.writes.push(next);
    },
  };
  return port;
}

beforeEach(() => {
  db.exec('delete from wind_down_state');
  db.exec('delete from wind_down_settings');
  db.exec('delete from stream_session_chatters');
  db.exec('delete from stream_sessions');
  getOrStartStreamSession('test', '2026-07-19T18:00:00.000Z');
});

describe('applyWindDownTitle', () => {
  test('captures the base title and appends the suffix', async () => {
    const fake = fakePort('Modding Skyrim');
    await applyWindDownTitle(fake.port, true);
    expect(fake.title).toBe('Modding Skyrim | Ending soon');
    expect(getWindDownState().baseTitle).toBe('Modding Skyrim');
  });

  test('restores the base title and forgets it', async () => {
    const fake = fakePort('Modding Skyrim');
    await applyWindDownTitle(fake.port, true);
    await applyWindDownTitle(fake.port, false);
    expect(fake.title).toBe('Modding Skyrim');
    expect(getWindDownState().baseTitle).toBeNull();
  });

  // The bug this guards: appending to the LIVE title rather than recomputing from
  // the stored base, so a second activation stacks a second suffix.
  test('activating twice never stacks the suffix', async () => {
    const fake = fakePort('Modding Skyrim');
    await applyWindDownTitle(fake.port, true);
    await applyWindDownTitle(fake.port, true);
    expect(fake.title).toBe('Modding Skyrim | Ending soon');
  });

  test('does nothing when the title effect is disabled', async () => {
    saveWindDownSettings({ leadMinutes: 15, titleSuffix: '| Ending soon', titleEnabled: false, overlayEnabled: true });
    const fake = fakePort('Modding Skyrim');
    await applyWindDownTitle(fake.port, true);
    expect(fake.writes).toHaveLength(0);
    expect(fake.title).toBe('Modding Skyrim');
  });

  test('deactivating with no stored base title writes nothing', async () => {
    const fake = fakePort('Something Else');
    await applyWindDownTitle(fake.port, false);
    expect(fake.writes).toHaveLength(0);
  });

  // A failed title update must not lose the base title, or the restore path has
  // nothing to restore to.
  test('a Twitch failure propagates without stranding the base title', async () => {
    const fake = fakePort('Modding Skyrim');
    fake.failNextWrite = true;
    await expect(applyWindDownTitle(fake.port, true)).rejects.toThrow('Twitch is down');
    expect(fake.title).toBe('Modding Skyrim');
  });
});

describe('reconcileWindDownOnBoot', () => {
  // The failure this exists for: a restart mid-wind-down leaving "| Ending soon"
  // welded to the title into the next stream.
  test('re-applies the suffix when the stored state says active', async () => {
    const fake = fakePort('Modding Skyrim');
    await applyWindDownTitle(fake.port, true);
    setWindDownActive({ active: true, source: 'scheduled' });

    // Simulate a restart: the channel title is whatever we left it as.
    const afterRestart = fakePort(fake.title);
    await reconcileWindDownOnBoot(afterRestart.port);
    expect(afterRestart.title).toBe('Modding Skyrim | Ending soon');
    expect(getWindDownState().baseTitle).toBe('Modding Skyrim');
  });

  test('does nothing when wind-down is not active', async () => {
    const fake = fakePort('Modding Skyrim');
    await reconcileWindDownOnBoot(fake.port);
    expect(fake.writes).toHaveLength(0);
  });
});

```

- [ ] **Step 3: Run the test to verify it fails**

Run: `bun test src/server/windDownLoop.test.ts`
Expected: FAIL — `Cannot find module './windDownLoop'`

- [ ] **Step 4: Write the implementation**

Create `src/server/windDownLoop.ts`:

```ts
import { DASHBOARD_HEARTBEAT_MS } from '../shared/constants';
import type { RuntimeState } from './runtime';
import { getCurrentStreamSessionId, getPlannedStreamEnd } from './streamSession';
import { getTwitchChannelTitle, setTwitchChannelTitle } from './twitch/api';
import {
  broadcastWindDown,
  getWindDownSettings,
  getWindDownState,
  setWindDownActive,
  setWindDownBaseTitle,
} from './windDown';
import { evaluateWindDown } from './windDownSchedule';
import { composeWindDownTitle, stripWindDownSuffix } from './windDownTitle';

/**
 * The wind-down tick loop and the one place that edits the Twitch title for it.
 *
 * The Twitch calls are behind a port so the title logic — which is where the
 * interesting failure modes live — is testable without network.
 */

/** The Twitch surface this module needs, injected so tests can supply a fake channel. */
export type WindDownTitlePort = {
  getTitle: () => Promise<string>;
  setTitle: (title: string) => Promise<void>;
};

/** Exported so the `set_wind_down` Action step uses this port rather than rebuilding it. */
export function windDownTitlePort(state: RuntimeState): WindDownTitlePort {
  return {
    getTitle: () => getTwitchChannelTitle(state),
    setTitle: (title: string) => setTwitchChannelTitle(state, title),
  };
}

/**
 * Put the suffix up, or take it down.
 *
 * The live title is always recomputed from the stored base title, never appended to
 * whatever is currently on the channel, so repeated activation cannot stack suffixes.
 * The base title is only captured on the transition into wind-down, and only cleared
 * once the restore has actually landed.
 */
export async function applyWindDownTitle(port: WindDownTitlePort, active: boolean): Promise<void> {
  const settings = getWindDownSettings();
  if (!settings.titleEnabled) return;

  const stored = getWindDownState();

  if (active) {
    // An already-captured base title wins: it is the operator's real title, and the
    // live one has the suffix on it.
    const baseTitle = stored.baseTitle ?? await port.getTitle();
    const next = composeWindDownTitle(baseTitle, settings.titleSuffix);
    // Write first. A failed PATCH must not leave a base title recorded for a suffix
    // that never went up, and must not clear one that is still live.
    await port.setTitle(next);
    setWindDownBaseTitle(baseTitle);
    return;
  }

  // Nothing captured means the suffix never went up — there is nothing to restore.
  if (stored.baseTitle === null) return;
  await port.setTitle(stored.baseTitle);
  setWindDownBaseTitle(null);
}

/**
 * A restart while wind-down is active would otherwise leave the suffix welded to the
 * title with nothing left that knows what the title used to be. The base title is
 * persisted precisely so this can put things back the way they were.
 */
export async function reconcileWindDownOnBoot(port: WindDownTitlePort): Promise<void> {
  if (!getWindDownState().active) return;
  await applyWindDownTitle(port, true);
}

let windDownTimer: ReturnType<typeof setInterval> | null = null;
let running = false;

async function tick(port: WindDownTitlePort): Promise<void> {
  // Overlapping ticks could double-apply the title while a slow PATCH is in flight.
  if (running) return;
  running = true;
  try {
    const settings = getWindDownSettings();
    const decision = evaluateWindDown({
      now: Date.now(),
      plannedEndAt: getPlannedStreamEnd(),
      leadMinutes: settings.leadMinutes,
      sessionId: getCurrentStreamSessionId(),
      state: { active: getWindDownState().active, dismissedSessionId: getWindDownState().dismissedSessionId },
    });
    if (decision.action !== 'activate') return;

    setWindDownActive({ active: true, source: 'scheduled' });
    try {
      await applyWindDownTitle(port, true);
    } catch (error) {
      // The overlay signal is already up; only the title failed. Leave wind-down
      // active and let the next tick's reconcile retry rather than tearing down a
      // signal the viewer can already see.
      console.error('Wind-down: could not update the Twitch title:', error);
    }
  } finally {
    running = false;
  }
}

export function startWindDownLoop(state: RuntimeState) {
  const port = windDownTitlePort(state);

  void reconcileWindDownOnBoot(port)
    .then(() => broadcastWindDown())
    .catch(error => console.error('Wind-down: boot reconcile failed:', error));

  if (windDownTimer) clearInterval(windDownTimer);
  windDownTimer = setInterval(() => { void tick(port); }, DASHBOARD_HEARTBEAT_MS);
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test src/server/windDownLoop.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 6: Start the loop**

In `src/server/index.ts`, add the import alongside the other server-module imports:

```ts
import { startWindDownLoop } from './windDownLoop';
```

And in the `server.listen` callback, immediately after the `startAutomaticAds(runtimeState);` call (around line 158):

```ts
  startWindDownLoop(runtimeState);
```

- [ ] **Step 7: Re-base the title on a stream-info save**

In `src/server/twitch/api.ts`, inside the `app.patch('/api/twitch/stream-info', ...)` handler, replace the `await twitchFetch(...)` channel update call with a re-based title. Change:

```ts
    await twitchFetch(
      `https://api.twitch.tv/helix/channels?broadcaster_id=${encodeURIComponent(credentials.broadcasterId)}`,
      {
        credentials,
        method: 'PATCH',
        body: { title, game_id: gameId, tags },
        errorMessage: 'Twitch channel update failed.',
      },
    );
```

to:

```ts
    // While wind-down is active the operator is editing the SUFFIXED title they can
    // see. Re-base so their edit is kept as the new base title rather than being
    // clobbered, and so the suffix is not appended twice.
    const titleToSend = rebaseWindDownTitle(title);
    await twitchFetch(
      `https://api.twitch.tv/helix/channels?broadcaster_id=${encodeURIComponent(credentials.broadcasterId)}`,
      {
        credentials,
        method: 'PATCH',
        body: { title: titleToSend, game_id: gameId, tags },
        errorMessage: 'Twitch channel update failed.',
      },
    );
```

Add the import at the top of `src/server/twitch/api.ts`:

```ts
import { rebaseWindDownTitle } from '../windDown';
```

**Not** from `../windDownLoop` — that module imports this one, and the cycle would bite at load time. See the import-direction note at the top of this task.

- [ ] **Step 8: Verify and commit**

```bash
bun test
bun run typecheck
git add src/server/windDownLoop.ts src/server/windDownLoop.test.ts src/server/twitch/api.ts src/server/index.ts
git commit -m "feat: apply the wind-down title on a schedule"
```

---

### Task 7: The `set_wind_down` Action step

**Files:**
- Modify: `src/shared/api.ts`, `src/server/actions.ts`, `src/server/actionExecutor.ts`
- Modify: `src/client/pages/settings/automation.ts`, `src/client/pages/settings/ActionsPage.tsx`
- Test: `src/server/actionExecutor.test.ts` (append; create if absent)

**Interfaces:**
- Consumes: `setWindDownActive` from `./windDown` (Task 4), `applyWindDownTitle` from `./windDownLoop` (Task 6).
- Produces: the `'set_wind_down'` member of `ActionStepType`, and `SetWindDownPayload = { active: boolean }`.

- [ ] **Step 1: Add the shared contract**

In `src/shared/api.ts`, add `| 'set_wind_down'` to the end of the `ActionStepType` union (after `| 'twitch_ban';` — move the semicolon):

```ts
export type ActionStepType =
  | 'show_text'
  | 'play_media'
  | 'tts_speak'
  | 'send_chat'
  | 'llm_response'
  | 'obs_scene'
  | 'obs_transition'
  | 'twitch_shoutout'
  | 'twitch_whisper'
  | 'twitch_timeout'
  | 'twitch_ban'
  | 'set_wind_down';
```

Add the payload type immediately after `export type TwitchBanPayload = { loginTemplate: string; reasonTemplate: string };`:

```ts
/** Turns wind-down on or off. `active: false` is how an Action calls the stream back off. */
export type SetWindDownPayload = { active: boolean };
```

And add the `ActionStep` union member, after the `twitch_ban` line (again moving the semicolon):

```ts
  | { id: string; position: number; enabled: boolean; delayMs: number; type: 'twitch_ban'; payload: TwitchBanPayload }
  | { id: string; position: number; enabled: boolean; delayMs: number; type: 'set_wind_down'; payload: SetWindDownPayload };
```

- [ ] **Step 2: Accept the step server-side**

In `src/server/actions.ts`, add `'set_wind_down'` to the `STEP_TYPES` set (line 28). Then add this case to `normalizeStepPayload`, immediately after the `case 'twitch_ban':` block:

```ts
    case 'set_wind_down':
      return { active: value.active === true };
```

- [ ] **Step 3: Write the failing test**

Create (or append to) `src/server/actionExecutor.test.ts`:

```ts
import { beforeEach, describe, expect, test } from 'bun:test';
import type { Action } from '../shared/api';
import { createActionExecutor } from './actionExecutor';
import { db } from './db';
import { RuntimeState } from './runtime';
import { getOrStartStreamSession } from './streamSession';
import { getWindDownState } from './windDown';

function actionWithStep(active: boolean): Action {
  return {
    id: 'action-winddown',
    name: 'Wind down',
    description: '',
    enabled: true,
    quickDisable: false,
    steps: [{
      id: 'step-1',
      position: 0,
      enabled: true,
      delayMs: 0,
      type: 'set_wind_down',
      payload: { active },
    }],
    createdAt: '',
    updatedAt: '',
  };
}

beforeEach(() => {
  db.exec('delete from wind_down_state');
  db.exec('delete from wind_down_settings');
  db.exec('delete from stream_session_chatters');
  db.exec('delete from stream_sessions');
  getOrStartStreamSession('test', '2026-07-19T18:00:00.000Z');
});

describe('the set_wind_down step', () => {
  test('turns wind-down on', async () => {
    const executor = createActionExecutor({
      resolveMedia: () => null,
      state: new RuntimeState(),
      loadAction: () => actionWithStep(true),
      applyWindDownTitle: async () => undefined,
    });
    const result = await executor.runAction('action-winddown', {});
    expect(result.status).toBe('succeeded');
    expect(getWindDownState().active).toBe(true);
    expect(getWindDownState().source).toBe('action');
  });

  test('turns wind-down off', async () => {
    const on = createActionExecutor({
      resolveMedia: () => null,
      state: new RuntimeState(),
      loadAction: () => actionWithStep(true),
      applyWindDownTitle: async () => undefined,
    });
    await on.runAction('action-winddown', {});

    const off = createActionExecutor({
      resolveMedia: () => null,
      state: new RuntimeState(),
      loadAction: () => actionWithStep(false),
      applyWindDownTitle: async () => undefined,
    });
    await off.runAction('action-winddown', {});
    expect(getWindDownState().active).toBe(false);
  });

  // An Action is not the operator deciding to keep streaming, so it must not latch
  // the schedule off for the rest of the session.
  test('an Action switching it off does not latch a dismissal', async () => {
    const off = createActionExecutor({
      resolveMedia: () => null,
      state: new RuntimeState(),
      loadAction: () => actionWithStep(false),
      applyWindDownTitle: async () => undefined,
    });
    await off.runAction('action-winddown', {});
    expect(getWindDownState().dismissedSessionId).toBeNull();
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `bun test src/server/actionExecutor.test.ts`
Expected: FAIL — the switch in `dispatch` does not handle `set_wind_down`, and `applyWindDownTitle` is not a known dep.

- [ ] **Step 5: Dispatch the step**

In `src/server/actionExecutor.ts`, add the imports:

```ts
import { setWindDownActive } from './windDown';
import {
  applyWindDownTitle as applyWindDownTitleImpl,
  windDownTitlePort,
  type WindDownTitlePort,
} from './windDownLoop';
```

Add to `ActionExecutorDeps`, after `isMuted?: () => boolean;`:

```ts
  /** Seam for tests: applies (or removes) the wind-down title suffix. */
  applyWindDownTitle?: (port: WindDownTitlePort, active: boolean) => Promise<void>;
```

In the destructuring block in `createActionExecutor`, after `isMuted = () => false,`:

```ts
    applyWindDownTitle = applyWindDownTitleImpl,
```

And add this case to `dispatch`, immediately after the `case 'twitch_ban':` block:

```ts
      case 'set_wind_down': {
        setWindDownActive({ active: step.payload.active, source: 'action' });
        // The title is best-effort: the overlay signal has already gone out, and a
        // Twitch hiccup should not fail a step whose visible effect already landed.
        try {
          await applyWindDownTitle(windDownTitlePort(state), step.payload.active);
        } catch (error) {
          console.error('Actions: wind-down title update failed:', error);
        }
        return SUCCEEDED;
      }
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `bun test src/server/actionExecutor.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 7: Wire the client editor**

In `src/client/pages/settings/automation.ts`:

Add `'set_wind_down',` to the end of the `STEP_TYPES` array (line 31-43).

Add to `STEP_TYPE_LABELS`:

```ts
  set_wind_down: 'Set wind-down mode',
```

Add to `newStep`, after the `case 'twitch_ban':` branch:

```ts
    case 'set_wind_down':
      return { type, enabled: true, delayMs: 0, payload: { active: true } };
```

Add to `validateStep`, after the `case 'twitch_ban':` branch:

```ts
    case 'set_wind_down':
      return null;
```

In `src/client/pages/settings/ActionsPage.tsx`, add this branch to the step editor switch, after the `case 'twitch_ban':` branch:

```tsx
    case 'set_wind_down':
      return (
        <label className="field settings-wide-field">
          <span>Wind-down</span>
          <select
            value={step.payload.active ? 'on' : 'off'}
            disabled={disabled}
            onChange={event => onChange({ ...step, payload: { active: event.target.value === 'on' } })}
          >
            <option value="on">Turn wind-down on</option>
            <option value="off">Turn wind-down off</option>
          </select>
          <small className="action-hint">
            Adds or removes the ending-soon title suffix and the overlay countdown.
            Incoming raids are unaffected — Twitch has no API to block them.
          </small>
        </label>
      );
```

- [ ] **Step 8: Verify and commit**

```bash
bun test
bun run typecheck
git add src/shared/api.ts src/server/actions.ts src/server/actionExecutor.ts src/server/actionExecutor.test.ts src/client/pages/settings/automation.ts src/client/pages/settings/ActionsPage.tsx
git commit -m "feat: add a set_wind_down action step"
```

---

### Task 8: The countdown overlay

**Files:**
- Create: `src/client/windDownCountdown.ts`, `src/client/windDownCountdown.test.ts`, `src/client/windDown.ts`
- Modify: `src/client/routing.ts`, `src/client/routing.test.ts`, `src/client/main.tsx`, `src/client/pages/Overlay.tsx`, `src/client/services/dashboard.ts`, `src/client/styles.css`

**Interfaces:**
- Consumes: `WindDownPublicState` from `src/shared/api.ts` (Task 2); `/api/wind-down` (Task 4).
- Produces: `formatWindDownCountdown(msRemaining: number): string`; `useWindDownOverlay(): WindDownPublicState | null`; `useWindDown()`; `OverlayWindDownPage`; the `'winddown'` `OverlayName`.

- [ ] **Step 1: Write the failing countdown test**

Create `src/client/windDownCountdown.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { formatWindDownCountdown } from './windDownCountdown';

describe('formatWindDownCountdown', () => {
  test('reads in whole minutes', () => {
    expect(formatWindDownCountdown(25 * 60_000)).toBe('~25 min left');
    expect(formatWindDownCountdown(2 * 60_000)).toBe('~2 min left');
  });

  test('rounds up so it never reads a minute short', () => {
    expect(formatWindDownCountdown(90_000)).toBe('~2 min left');
  });

  test('the last minute reads in seconds', () => {
    expect(formatWindDownCountdown(45_000)).toBe('~45 sec left');
    expect(formatWindDownCountdown(5_000)).toBe('~5 sec left');
  });

  test('at or past zero it stops counting', () => {
    expect(formatWindDownCountdown(0)).toBe('ending soon');
    expect(formatWindDownCountdown(-60_000)).toBe('ending soon');
  });

  test('an hour or more reads in hours and minutes', () => {
    expect(formatWindDownCountdown(90 * 60_000)).toBe('~1h 30m left');
    expect(formatWindDownCountdown(60 * 60_000)).toBe('~1h 0m left');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test src/client/windDownCountdown.test.ts`
Expected: FAIL — `Cannot find module './windDownCountdown'`

- [ ] **Step 3: Write the countdown formatter**

Create `src/client/windDownCountdown.ts`:

```ts
/**
 * Relative rather than absolute on purpose: "~25 min left" reads better to a viewer
 * than a wall-clock time, and it does not leak the streamer's timezone.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export function formatWindDownCountdown(msRemaining: number): string {
  if (msRemaining <= 0) return 'ending soon';

  if (msRemaining < MINUTE_MS) {
    return `~${Math.ceil(msRemaining / 1000)} sec left`;
  }

  if (msRemaining < HOUR_MS) {
    // Ceiling, so a countdown never reads a minute shorter than it is.
    return `~${Math.ceil(msRemaining / MINUTE_MS)} min left`;
  }

  const hours = Math.floor(msRemaining / HOUR_MS);
  const minutes = Math.floor((msRemaining % HOUR_MS) / MINUTE_MS);
  return `~${hours}h ${minutes}m left`;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun test src/client/windDownCountdown.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Add the overlay route, test first**

In `src/client/routing.test.ts`, add:

```ts
test('the wind-down countdown resolves to its own source', () => {
  expect(overlayFromPath('/overlay/winddown')).toBe('winddown');
  expect(overlayFromPath('/overlay/winddown/')).toBe('winddown');
});
```

Run: `bun test src/client/routing.test.ts` — Expected: FAIL (`expected "winddown", got "unknown"`).

Then in `src/client/routing.ts`, add `| 'winddown'` to the `OverlayName` union (after `| 'text'`), and add to `OVERLAY_BY_PATH`, after the `'/overlay/text': 'text',` line:

```ts
  '/overlay/winddown': 'winddown',
```

Run: `bun test src/client/routing.test.ts` — Expected: PASS.

- [ ] **Step 6: Add the client service calls**

In `src/client/services/dashboard.ts`, add after `setMediaMute`:

```ts
export async function getWindDown(): Promise<WindDownPublicState> {
  return fetchJson<WindDownPublicState>('/api/wind-down');
}

export async function setWindDown(active: boolean): Promise<WindDownPublicState> {
  return sendJson<WindDownPublicState>('/api/wind-down', 'PUT', { active });
}

export async function getWindDownSettings(): Promise<WindDownSettings> {
  return fetchJson<WindDownSettings>('/api/wind-down/settings');
}

export async function saveWindDownSettings(settings: Omit<WindDownSettings, 'updatedAt'>): Promise<WindDownSettings> {
  return sendJson<WindDownSettings>('/api/wind-down/settings', 'PUT', settings);
}
```

Add `WindDownPublicState` and `WindDownSettings` to the existing type import from `'../../shared/api'` at the top of the file.

- [ ] **Step 7: Add the hooks**

Create `src/client/windDown.ts`:

```ts
import React from 'react';
import type { WindDownPublicState } from '../shared/api';
import { useSocket } from './realtime';
import { getWindDown, setWindDown } from './services/dashboard';

/**
 * REST seed plus live `winddown:updated`. Used by both the operator toggle and the
 * overlay browser source — the GET is on the overlay token's read allowlist so a
 * source can seed itself, and the PUT is operator-only.
 */
function useWindDownState() {
  const [state, setState] = React.useState<WindDownPublicState | null>(null);

  React.useEffect(() => {
    getWindDown()
      .then(setState)
      .catch(() => setState(null));
  }, []);

  useSocket<WindDownPublicState>(
    'winddown:updated',
    React.useCallback((next: WindDownPublicState) => setState(next), []),
  );

  return [state, setState] as const;
}

/** Read-only, for the browser source. */
export function useWindDownOverlay(): WindDownPublicState | null {
  const [state] = useWindDownState();
  return state;
}

/** Read/write, for the dashboard control. */
export function useWindDown() {
  const [state, setState] = useWindDownState();
  const [busy, setBusy] = React.useState(false);

  const toggle = React.useCallback((next: boolean) => {
    setBusy(true);
    setWindDown(next)
      .then(setState)
      .catch(() => undefined)
      .finally(() => setBusy(false));
  }, [setState]);

  return { state, busy, toggle };
}
```

- [ ] **Step 8: Add the overlay page**

In `src/client/pages/Overlay.tsx`, add the imports at the top:

```tsx
import { useWindDownOverlay } from '../windDown';
import { formatWindDownCountdown } from '../windDownCountdown';
```

And add this component after `OverlayStatusPage`:

```tsx
/**
 * The wind-down signal: a prospective raider deciding whether to send their viewers
 * here can see the stream is wrapping up. Twitch offers no way to block an incoming
 * raid, so telling them is the whole mechanism.
 *
 * The countdown ticks client-side from `plannedEndAt` rather than from server
 * messages, so it stays smooth without a broadcast every second.
 */
export function OverlayWindDownPage() {
  const state = useWindDownOverlay();
  const [now, setNow] = React.useState(() => Date.now());

  const active = Boolean(state?.active && state.overlayEnabled);

  React.useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);

  if (!active) return <main className="overlay-widget overlay-winddown-widget" aria-label="Wind-down overlay" />;

  const endMs = state?.plannedEndAt ? new Date(state.plannedEndAt).getTime() : Number.NaN;
  const countdown = Number.isFinite(endMs) ? formatWindDownCountdown(endMs - now) : null;

  return (
    <main className="overlay-widget overlay-winddown-widget" aria-label="Wind-down overlay">
      <div className="overlay-winddown-card">
        <span className="overlay-winddown-label">Wrapping up</span>
        {countdown ? <span className="overlay-winddown-countdown">{countdown}</span> : null}
      </div>
    </main>
  );
}
```

- [ ] **Step 9: Register the overlay component**

In `src/client/main.tsx`, add `OverlayWindDownPage` to the existing import from `'./pages/Overlay'`, and add to `OVERLAY_PAGES`:

```ts
  winddown: OverlayWindDownPage,
```

- [ ] **Step 10: Style it**

Append to `src/client/styles.css`:

```css
/* Wind-down countdown browser source. Transparent and fixed-position like every
   other overlay — no app chrome, per the overlay rules. */
.overlay-winddown-widget {
  position: fixed;
  top: 24px;
  right: 24px;
  display: flex;
  justify-content: flex-end;
  pointer-events: none;
}

.overlay-winddown-card {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
  padding: 10px 16px;
  border-radius: 10px;
  background: rgba(12, 10, 24, 0.72);
  border: 1px solid rgba(255, 255, 255, 0.14);
  font-family: system-ui, sans-serif;
  color: #fff;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.6);
}

.overlay-winddown-label {
  font-size: 13px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  opacity: 0.75;
}

.overlay-winddown-countdown {
  font-size: 22px;
  font-weight: 600;
}
```

- [ ] **Step 11: Verify and commit**

```bash
bun test
bun run typecheck
git add src/client/windDown.ts src/client/windDownCountdown.ts src/client/windDownCountdown.test.ts src/client/routing.ts src/client/routing.test.ts src/client/main.tsx src/client/pages/Overlay.tsx src/client/services/dashboard.ts src/client/styles.css
git commit -m "feat: add the wind-down countdown overlay"
```

---

### Task 9: Dashboard control and the planned-end field

**Files:**
- Modify: `src/client/ui/panels.tsx`, `src/client/pages/StreamInfoModal.tsx`, `src/client/pages/Dashboard.tsx`, `src/client/services/dashboard.ts`, `src/client/styles/panel.css`
- Modify: `src/server/routes.ts` (or `src/server/windDown.ts` — see step 1)

**Interfaces:**
- Consumes: `useWindDown` (Task 8), `setPlannedStreamEnd`/`getPlannedStreamEnd` (Task 3).
- Produces: `GET/PUT /api/stream-session/planned-end`; `StreamInfoForm.plannedEndAt: string`.

- [ ] **Step 1: Add the planned-end route**

In `src/server/windDown.ts`, add the import:

```ts
import { getCurrentStreamSessionId, getPlannedStreamEnd, setPlannedStreamEnd } from './streamSession';
```

(replacing the existing two-name import), and add these routes inside `registerWindDownRoutes`:

```ts
  app.get('/api/stream-session/planned-end', (_request, response) => {
    response.json({ plannedEndAt: getPlannedStreamEnd() });
  });

  app.put('/api/stream-session/planned-end', handle((request, response) => {
    const sessionId = getCurrentStreamSessionId();
    if (!sessionId) throw new HttpRouteError(409, 'There is no active stream session to plan an end for.');

    const raw = (request.body as { plannedEndAt?: unknown } | null)?.plannedEndAt;
    if (raw === null || raw === undefined || raw === '') {
      setPlannedStreamEnd(sessionId, null);
      broadcastWindDown();
      return response.json({ plannedEndAt: null });
    }

    const parsed = new Date(String(raw));
    if (Number.isNaN(parsed.getTime())) throw new HttpRouteError(400, 'Planned end time is not a valid date.');

    const plannedEndAt = parsed.toISOString();
    setPlannedStreamEnd(sessionId, plannedEndAt);
    // The overlay countdown reads plannedEndAt off this event, so changing the plan
    // has to re-broadcast or a running countdown keeps the old target.
    broadcastWindDown();
    return response.json({ plannedEndAt });
  }));
```

- [ ] **Step 2: Add the client service calls**

In `src/client/services/dashboard.ts`, after `saveWindDownSettings`:

```ts
export async function getPlannedStreamEnd(): Promise<{ plannedEndAt: string | null }> {
  return fetchJson<{ plannedEndAt: string | null }>('/api/stream-session/planned-end');
}

export async function setPlannedStreamEnd(plannedEndAt: string | null): Promise<{ plannedEndAt: string | null }> {
  return sendJson<{ plannedEndAt: string | null }>('/api/stream-session/planned-end', 'PUT', { plannedEndAt });
}
```

- [ ] **Step 3: Add the dashboard toggle**

In `src/client/ui/panels.tsx`, add the import:

```ts
import { useWindDown } from '../windDown';
```

And add this component immediately after `MediaMuteToggle`:

```tsx
/**
 * The wind-down switch. Signals that the stream is wrapping up — the ending-soon
 * title suffix and the overlay countdown. It does NOT block incoming raids: Twitch
 * exposes no API for that, and a raid during wind-down still celebrates in full.
 */
function WindDownToggle() {
  const { state, busy, toggle } = useWindDown();
  const active = Boolean(state?.active);

  return (
    <div className="ctrl-section ctrl-winddown-section">
      <span className="ctrl-label">wind-down</span>
      <label className={'ctrl-toggle' + (active ? ' is-winding-down' : '')}>
        <input
          type="checkbox"
          checked={active}
          disabled={busy}
          onChange={event => toggle(event.target.checked)}
        />
        <span>Signal ending soon</span>
      </label>
      {active && (
        <p className="ctrl-overlay-warning" role="status">
          {state?.source === 'scheduled' ? 'Started automatically. ' : ''}
          Title suffix and countdown overlay are live. Raids still land and still celebrate.
        </p>
      )}
    </div>
  );
}
```

Then render it: find the JSX where `<MediaMuteToggle />` is rendered in `panels.tsx` and add `<WindDownToggle />` immediately after it.

- [ ] **Step 4: Add the planned-end field to the modal**

In `src/client/pages/StreamInfoModal.tsx`, extend the form type (line 8):

```ts
export type StreamInfoForm = {
  title: string;
  category: string;
  categoryId?: string;
  tags: string[];
  status: string;
  /** `datetime-local` value ('' when no plan). Local time, converted on save. */
  plannedEndAt: string;
};
```

Add this field to the form JSX, immediately before the status field:

```tsx
          <label className="field">
            <span>Planned end (optional)</span>
            <input
              type="datetime-local"
              value={form.plannedEndAt}
              disabled={loading}
              onChange={event => setForm(prev => ({ ...prev, plannedEndAt: event.target.value }))}
            />
            <small className="field-hint">
              Wind-down signals that the stream is wrapping up shortly before this. You can change
              it mid-stream if you run long.
            </small>
          </label>
```

- [ ] **Step 5: Wire it in the dashboard**

In `src/client/pages/Dashboard.tsx`:

Add to the imports from `'../services/dashboard'`: `getPlannedStreamEnd`, `setPlannedStreamEnd`.

Change the initial form state (line 128) to include the new field:

```ts
  const [streamInfoForm, setStreamInfoForm] = useState<StreamInfoForm>({ title: '', category: '', tags: [], status: '', plannedEndAt: '' });
```

Add these helpers above `handleOpenStreamInfo`:

```ts
  // <input type="datetime-local"> speaks local wall-clock with no zone; the API
  // speaks RFC3339 UTC. These two are the only place that conversion happens.
  const toLocalInputValue = (iso: string | null): string => {
    if (!iso) return '';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  };

  const fromLocalInputValue = (value: string): string | null => {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  };
```

In `handleOpenStreamInfo`, change the `Promise.all` to also load the planned end:

```ts
    void Promise.all([getStreamInfo(), getStreamStatus(), getPlannedStreamEnd()])
      .then(([info, status, planned]) => {
        setStreamInfoForm({
          title: info.title,
          category: info.category,
          categoryId: info.categoryId || undefined,
          tags: info.tags,
          status: status.text,
          plannedEndAt: toLocalInputValue(planned.plannedEndAt),
        });
      })
```

In `handleStreamInfoSubmit`, add the planned-end save to the `Promise.all`:

```ts
    void Promise.all([
      updateStreamInfo({
        title: streamInfoForm.title,
        category: streamInfoForm.category,
        categoryId: streamInfoForm.categoryId,
        tags: streamInfoForm.tags,
      }),
      updateStreamStatus(streamInfoForm.status),
      // Off-stream there is no session to hang a plan on; the route 409s and that is
      // not worth failing the whole save over.
      setPlannedStreamEnd(fromLocalInputValue(streamInfoForm.plannedEndAt)).catch(() => undefined),
    ])
```

- [ ] **Step 6: Style the toggle**

Append to `src/client/styles/panel.css`:

```css
.ctrl-toggle.is-winding-down {
  color: var(--accent-warning, #f0b429);
}
```

- [ ] **Step 7: Verify and commit**

```bash
bun test
bun run typecheck
bun run build
git add src/server/windDown.ts src/client/services/dashboard.ts src/client/ui/panels.tsx src/client/pages/StreamInfoModal.tsx src/client/pages/Dashboard.tsx src/client/styles/panel.css
git commit -m "feat: add the wind-down toggle and planned end time"
```

---

### Task 10: Settings section

**Files:**
- Create: `src/client/pages/settings/WindDownSection.tsx`
- Modify: `src/client/pages/settings/sections.ts`, `src/client/pages/settings/SettingsShell.tsx`, `src/client/routing.ts`, `src/client/routing.test.ts`

**Interfaces:**
- Consumes: `getWindDownSettings`/`saveWindDownSettings` from the dashboard service (Task 8).
- Produces: the `'winddown'` settings route at `/settings/wind-down`.

- [ ] **Step 1: Add the route, test first**

In `src/client/routing.test.ts`, add:

```ts
test('the wind-down settings section is routable', () => {
  expect(dashboardRouteFromPath('/settings/wind-down')).toBe('winddown');
  expect(pathForDashboardRoute('winddown')).toBe('/settings/wind-down');
});
```

Run: `bun test src/client/routing.test.ts` — Expected: FAIL.

In `src/client/routing.ts`, add `| 'winddown'` to the `SettingsRoute` union, add `winddown: '/settings/wind-down',` to `PATH_BY_ROUTE`, and add `'winddown'` to the `SETTINGS_ROUTES` set literal.

Run: `bun test src/client/routing.test.ts` — Expected: PASS.

- [ ] **Step 2: Write the section**

Create `src/client/pages/settings/WindDownSection.tsx`:

```tsx
import React from 'react';
import type { WindDownSettings } from '../../../shared/api';
import { errorMessage } from '../../errors';
import { getWindDownSettings, saveWindDownSettings } from '../../services/dashboard';
import { SettingsHeader, SettingsRow } from './shared';

const EMPTY: Omit<WindDownSettings, 'updatedAt'> = {
  leadMinutes: 15,
  titleSuffix: '| Ending soon',
  titleEnabled: true,
  overlayEnabled: true,
};

export function WindDownSection() {
  const [form, setForm] = React.useState(EMPTY);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    getWindDownSettings()
      .then(settings => setForm({
        leadMinutes: settings.leadMinutes,
        titleSuffix: settings.titleSuffix,
        titleEnabled: settings.titleEnabled,
        overlayEnabled: settings.overlayEnabled,
      }))
      .catch(caught => setError(errorMessage(caught, 'Could not load wind-down settings')))
      .finally(() => setLoading(false));
  }, []);

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setMessage(null);
    setError(null);
    saveWindDownSettings(form)
      .then(() => setMessage('Wind-down settings saved'))
      .catch(caught => setError(errorMessage(caught, 'Could not save wind-down settings')))
      .finally(() => setSaving(false));
  };

  return (
    <form className="settings-section" onSubmit={submit}>
      <SettingsHeader
        title="Wind-down"
        description={
          'Signals that the stream is wrapping up, shortly before your planned end time. ' +
          'Twitch has no API to block incoming raids, so this tells a prospective raider ' +
          'rather than stopping them — a raid during wind-down still celebrates in full.'
        }
        saving={saving}
        message={message}
        error={error}
      />

      <SettingsRow label="Lead time" hint="Minutes before your planned end to start signalling. 0 turns the schedule off.">
        <input
          type="number"
          min={0}
          max={720}
          value={form.leadMinutes}
          disabled={loading}
          onChange={event => setForm(prev => ({ ...prev, leadMinutes: Number(event.target.value) }))}
        />
      </SettingsRow>

      <SettingsRow label="Title suffix" hint="Appended to your Twitch title while winding down. Your title is restored when it ends.">
        <input
          type="text"
          maxLength={60}
          value={form.titleSuffix}
          disabled={loading}
          onChange={event => setForm(prev => ({ ...prev, titleSuffix: event.target.value }))}
        />
      </SettingsRow>

      <SettingsRow label="Update the title" hint="Turn off to leave your Twitch title untouched.">
        <input
          type="checkbox"
          checked={form.titleEnabled}
          disabled={loading}
          onChange={event => setForm(prev => ({ ...prev, titleEnabled: event.target.checked }))}
        />
      </SettingsRow>

      <SettingsRow label="Show the overlay" hint="The /overlay/winddown browser source and its countdown.">
        <input
          type="checkbox"
          checked={form.overlayEnabled}
          disabled={loading}
          onChange={event => setForm(prev => ({ ...prev, overlayEnabled: event.target.checked }))}
        />
      </SettingsRow>

      <button type="submit" disabled={loading || saving}>Save</button>
    </form>
  );
}
```

Before writing this file, open `src/client/pages/settings/shared.tsx` and confirm the actual prop names of `SettingsHeader` and `SettingsRow`; match them exactly rather than the shape assumed above.

- [ ] **Step 3: Register the section**

In `src/client/pages/settings/sections.ts`, add an entry for `winddown` following the shape of the existing entries (id, label, and whatever else that registry declares — read the file and match it).

In `src/client/pages/settings/SettingsShell.tsx`, add the `winddown` case to the body selection so it renders `<WindDownSection />`.

- [ ] **Step 4: Verify and commit**

```bash
bun test
bun run typecheck
bun run build
git add src/client/pages/settings/WindDownSection.tsx src/client/pages/settings/sections.ts src/client/pages/settings/SettingsShell.tsx src/client/routing.ts src/client/routing.test.ts
git commit -m "feat: add the wind-down settings section"
```

---

### Task 11: Documentation and end-to-end verification

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update the architecture map**

In `CLAUDE.md`, add to the `src/server/` file listing:

```
    windDown.ts         # wind-down settings + state store and routes
    windDownLoop.ts     # the wind-down tick loop + Twitch title application
    windDownSchedule.ts # the pure evaluateWindDown decision
    windDownTitle.ts    # title composition + the 140-char truncation rule
```

And to the `src/client/` listing:

```
    windDown.ts         # useWindDown / useWindDownOverlay hooks
    windDownCountdown.ts # relative countdown formatting
```

Add this section after the **Overlay bounds** section:

```markdown
**Wind-down** (`windDown.ts`, `windDownLoop.ts`) — signals that the stream is
wrapping up, automatically some configurable number of minutes before the planned
end time on the session, or manually, or from a `set_wind_down` Action step.

**Twitch exposes no API to block incoming raids.** Not Helix, not EventSub, not a
chat command; `channel:manage:raids` is outbound-only, and Shield Mode is an opaque
container of broadcaster-configured overrides that the API cannot read. The Creator
Dashboard's own "Stop Raids for 1 Hour" has no API. So wind-down *signals* — a title
suffix and an overlay countdown — and must never be described as blocking anything.
**Raid alerts are deliberately not suppressed during wind-down**: a raid five
minutes before the end is more worth celebrating, not less.

The scheduler is a pure `evaluateWindDown` decision plus a tick loop, the same split
as `automaticAds.ts`. Three rules carry the weight: `base_title` is **persisted**, so
a restart mid-wind-down cannot strand the suffix on the operator's title into the
next stream; the live title is always recomputed as base + suffix rather than
appended to the live value, so toggling twice cannot stack suffixes; and a **manual**
switch-off latches `dismissed_session_id` for the rest of the session, so deciding to
keep streaming is not undone by the next tick. An Action or the scheduler turning it
off does not latch.

The title update calls `PATCH /helix/channels` directly rather than the app's own
`/api/twitch/stream-info` route — that route requires a category and fires
`onCategorySignal`, so routing a title tweak through it would re-trigger
category-module switching from a clock tick.
```

- [ ] **Step 2: Run the full verification**

```bash
bun run typecheck
bun test
bun run build
```

Expected: typecheck clean, build succeeds, and **no new test failures**.

> **This worktree has 21 pre-existing failures, and they are not yours.** `public/clips/`
> and `public/sounds/` are gitignored with zero files tracked under `public/`, so a git
> worktree contains no media at all and every test that scans the media catalog fails
> (`listMediaFiles`, `createMediaAsset validation`, `resolveMediaAssetForPlayback`,
> `redeemOnce`, and friends). Verified identical at the branch's start commit `b9061a4`.
> The bar for this feature is **21 failures and no more** — count them, do not chase them,
> and do not "fix" a media test by weakening it.

- [ ] **Step 3: Smoke-test the endpoints**

Confirm port 4317 is free first (`lsof -i :4317`), stop any stale project process, then start the dev server against a scratch database so the operator's real data is untouched:

```bash
STREAMER_TOOLS_DB=/tmp/winddown-scratch.sqlite bun run dev
```

Then:

```bash
curl http://localhost:4317/api/health
curl http://localhost:4317/api/wind-down
curl http://localhost:4317/api/wind-down/settings
curl -X PUT -H 'Content-Type: application/json' -d '{"active":true}' http://localhost:4317/api/wind-down
curl http://localhost:4317/api/wind-down
```

Expected: the GET reports `active: false` initially and `active: true` after the PUT, with `source: "manual"`.

- [ ] **Step 4: Verify the overlay visually**

With the dev server running, open `http://localhost:5173/overlay/winddown` in the browser preview. With wind-down off the page must be **empty and transparent** — no chrome. Switch it on via the PUT above and confirm the card appears; set a planned end a few minutes out and confirm the countdown ticks down each second. Screenshot both states.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document wind-down in the architecture map"
```

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| `stream_sessions.planned_end_at`, editable mid-stream | 3, 9 |
| Wind-down state table following `media_mute` | 4 |
| `winddown:updated` on `OVERLAY_EVENTS`, GET on `OVERLAY_PATHS`, PUT operator-only | 5 |
| Pure `evaluateWindDown` + tick loop | 2, 6 |
| Title suffix via `PATCH /helix/channels`, not the stream-info route | 6 |
| 140-character truncation rule | 1 |
| `/overlay/winddown` + relative countdown, registered in `routing.ts` and covered in `routing.test.ts` | 8 |
| Dashboard toggle | 9 |
| `set_wind_down` Action step | 7 |
| Four configuration values in Settings | 4 (storage), 10 (UI) |
| Title restore after restart | 6 |
| No double-append | 1, 6 |
| Manual off latches | 2, 4 |
| Running over does not undo | 2 |
| Re-base on operator title edit | 6 |
| Twitch unreachable does not block the overlay | 6, 7 |
| Raid alerts NOT suppressed | Global Constraints — no task, by design |

**Deviations from the spec, both deliberate and flagged above:** configuration lives in `wind_down_settings` rather than `app_config`; "stream ends while active" is handled by `getPlannedStreamEnd` reading only the active session (Task 3) rather than an explicit teardown hook — Task 3's fourth test covers it.

**Type consistency check:** `WindDownPublicState` is used identically in Tasks 2, 4, 8, 9. `WindDownStoredState` is server-only and never crosses the wire. `WindDownSchedulerState` (Task 2) is the narrow subset the decision needs and is constructed from `getWindDownState()` in Task 6. `WindDownTitlePort` is defined in Task 6 and consumed in Task 7. `applyWindDownTitle` has the same signature in both.

**Open risk to watch during implementation:** Task 10 assumes prop shapes for `SettingsHeader`/`SettingsRow` and the `sections.ts` registry entry format. Step 2 of that task says to read the real files and match them; do not paste the assumed shape blind.
