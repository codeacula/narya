# Counter system — design

**Date:** 2026-07-19
**Status:** Approved, ready for implementation

## Problem

The operator wants durable named tallies — a death counter, a "times I said the thing"
counter — that automation can move and that display surfaces can show. Two capabilities:

1. An Action step that increments, decrements, resets, or sets a counter, so any existing
   trigger source (reward, chat command, dashboard slash, Twitch event, module lifecycle)
   can move a counter without new trigger machinery.
2. A template token so a counter's value can appear in chat replies, overlay text, TTS,
   and — specifically requested — the stream status line: `Total Deaths: {counter:zambie-deaths}`.

## Non-goals

- Per-module or per-category automatic scoping. Counters are a flat namespace; per-game
  separation is a naming convention (`zambie-deaths`), not a schema feature.
- Automatic per-stream-session reset, and dual session/all-time values. A counter is one
  integer. Resetting is an explicit act — by hand or by an Action step.
- Counter history or an audit log of adjustments.

## Storage

A new table in `db.ts`, idempotent by construction like its neighbours:

```sql
create table if not exists counters (
  id text primary key,
  key text not null unique,
  label text not null,
  value integer not null default 0,
  created_at text not null,
  updated_at text not null
);
```

- `key` is the template token and is normalized on write: lowercased, whitespace and
  underscores collapsed to `-`, restricted to `[a-z0-9-]`, trimmed of leading/trailing
  `-`. Normalizing on write rather than matching loosely on read means the token the
  operator types is exactly the token that was stored.
- An empty key after normalization is rejected.
- `label` is the human name shown in the settings UI and counter list.
- `value` is a signed integer. Going below zero is allowed: a counter is not necessarily
  a tally, and clamping would silently lose an operator's `set -5`.

No data migration. Counters start empty; there is nothing in the existing schema to
derive them from, so `runOnce` is not involved.

## Contracts (`src/shared/api.ts`)

```ts
export type Counter = {
  id: string;
  key: string;
  label: string;
  value: number;
  createdAt: string;
  updatedAt: string;
};

/** POST body. `value` seeds the starting count. */
export type CounterInput = { key: string; label: string; value: number };

/** PUT accepts partial bodies; absent fields keep their current value. */
export type CounterUpdate = Partial<CounterInput>;

/** GET /api/counters and the `counters:updated` WebSocket payload. */
export type CountersResponse = { counters: Counter[] };
```

`counters:updated` carries the full list rather than a delta. The list is small and
bounded by how many counters an operator hand-creates, and a full-list payload cannot
drift out of sync the way an incremental one can.

## The Action step

One new `ActionStepType`: `adjust_counter`. Not separate increment/decrement/reset types.

```ts
export type CounterAdjustMode = 'add' | 'set';
export type AdjustCounterPayload = {
  counterId: string;
  mode: CounterAdjustMode;
  amountTemplate: string;
};
```

- `mode: 'add'` with `1` increments; with `-1` decrements.
- `mode: 'set'` with `0` is a reset. This is why there is one step type and not three —
  "an Action that resets the counter" is `set 0`, and no additional surface is needed.
- `amountTemplate` is a template, not a number, for the same reason
  `TwitchTimeoutPayload.secondsTemplate` is: `!death 3` can bind `{arg1}`.

### Failure behavior

Unlike `twitch_timeout`, an amount that renders empty or non-numeric **skips the step**
rather than falling back to a default. There is no safe default for "how much": writing a
guessed number into a durable counter is worse than not writing at all, and the step
result says why. Non-integers are rounded (`Math.round`) so `{arg1}` = `2.6` does not
write a float into an integer column.

An unknown or deleted `counterId` also skips, consistent with how `play_media` treats an
unresolvable asset.

The step's `detail` reports the resulting value on success (`deaths: 41 → 42`), so an
Action run result shows what actually happened.

### Executor wiring

`adjustCounter` is injected into `createActionExecutor` as a dep (defaulting to the real
`counters.ts` function), matching every other side-effecting call in that module, so the
step is testable without a database.

## The template token

`renderActionTemplate` gains one token family: `{counter:some-key}`.

This requires widening `TOKEN_PATTERN` from `\{([A-Za-z][A-Za-z0-9]*)\}` to also admit
`:` and `-` inside the token body. The widening must not change how any existing token
renders, and must not make an unknown token stop rendering literally.

Resolution rules, consistent with the existing renderer:

- A **known** counter key renders its value. Value `0` renders `0`, not empty.
- An **unknown** counter key renders the **literal token** (`{counter:typo}`). This
  follows the established rule that an operator's typo stays visible, and is deliberately
  different from a known-but-absent context field like `{months}`, which renders empty.
- Rendering stays **single-pass**. A counter value is numeric so it cannot itself contain
  a token, but the guarantee is structural, not incidental.

The lookup is a function injected into the renderer, not a direct `db` import:
`actionTemplates.ts` is currently free of both React and the database, and stays unit
testable without one. The default resolver reads from `counters.ts`.

One change here reaches every template surface: `send_chat`, `show_text`, `tts_speak`,
`llm_response`, `twitch_whisper`, and the timeout reason.

## Stream status

The status line is stored freeform text, not a template, and is read by an unauthenticated
overlay browser source. Handling:

- The stored text keeps its raw `{counter:...}` tokens so it remains editable.
- `StreamStatus.text` — the field the overlay and the `status:updated` broadcast carry —
  is **rendered**. An overlay never receives a raw token and never needs to know counters
  exist.
- `StreamStatus` gains `rawText`, returned by the operator-only `GET /api/stream-status`
  so the dashboard editor can round-trip what the operator typed. `rawText` must **not**
  ride on the `status:updated` broadcast, which is on the `OVERLAY_EVENTS` allowlist.

When a counter changes, `status:updated` is re-broadcast **only if** the stored raw text
actually contains a `{counter:` token. Otherwise every increment would push a status event
to every connected overlay for no reason.

This is a contract change, so every producer and consumer is traced: `server/streamStatus.ts`,
`server/auth.ts` (allowlist), `client/streamStatus.ts`, `client/pages/Overlay.tsx`,
`client/pages/Dashboard.tsx`, `client/services/dashboard.ts`.

## Operator surfaces

**Settings → Counters section.** Create, rename, delete, and directly edit the current
value. Direct editing matters: a miscounted death should not require issuing a
compensating chat command.

**`/counter` dashboard slash command**, seeded through `runOnce` alongside the existing
built-ins:

- `/counter deaths` — report the current value
- `/counter deaths +1` / `-1` — adjust
- `/counter deaths set 0` — set

Server-owned and executed or rejected server-side, never forwarded to Twitch, per the
existing slash-command rule.

**Deletion referencing.** Deleting a counter that an `adjust_counter` step references is
rejected with a message naming the offending Actions, rather than silently leaving steps
pointing at nothing.

## Ordering guarantee

`delayMs` is relative to the start of an invocation and same-delay steps start without
awaiting each other, while counter tokens resolve at each step's dispatch. Because
`adjust_counter` performs a synchronous write and steps dispatch in stored order, an
adjust step placed **before** a `show_text` step at the same delay is reflected in the
rendered banner.

This is a real guarantee but currently an incidental one, so it gets a test that pins it:
an Action whose step 1 increments and whose step 2 renders `{counter:...}` must show the
post-increment value.

## Testing

- `counters.test.ts` — key normalization, negative values, unknown-id handling,
  delete-while-referenced rejection.
- `actionTemplates.test.ts` — the new token, unknown key rendering literally, zero
  rendering as `0`, no regression in existing tokens under the widened pattern, single-pass
  guarantee.
- `actionExecutor.test.ts` — add/set, non-numeric skip, unknown counter skip, the
  adjust-then-display ordering guarantee.
- `streamStatus.test.ts` — rendered vs raw separation, and that a counter change only
  re-broadcasts when the status text actually references a counter.

All tests run under `bun test`, which sets `NODE_ENV=test` before any import so the
database is in-memory. No ad-hoc script touches the operator's database.
