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

This requires widening `TOKEN_PATTERN` to `/\{([A-Za-z][A-Za-z0-9:-]*)\}/g`.

The widening is safe by construction, and the argument is worth recording because it is
load-bearing: neither `{` nor `}` is in the character class, so a match's extent is fully
determined by its opening `{` and the next `}` — independent of the class. Widening the
class therefore cannot change any existing match's extent and cannot let a new match
cannibalize an old one. The only behavioral delta is that strings like `{a-b}` and `{x:y}`
now *enter* the replace callback, where the unknown-token branch returns `match` verbatim,
making the output byte-identical.

Two constraints follow, and both get a comment at the pattern:

- The identity holds **only** because the unknown branch returns `match` rather than `''`.
  The widening and the leave-typos-visible rule are now coupled.
- `ARG_TOKEN_PATTERN` and `REST_TOKEN_PATTERN` are `^…$`-anchored, which is what stops
  `{arg1-x}` reading as `{arg1}` under the wider lexer. They must not be unanchored.

Regression tests assert `{a-b}` and `{x:y}` round-trip unchanged.

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

Three constraints on the resolver's shape:

- It must be **synchronous**. `String.replace` callbacks cannot await, and making it async
  would infect all eleven render sites in the executor.
- It must be a **function, not a snapshot map**, because the ordering guarantee below
  requires step 2 to observe step 1's write.
- It must **not** live on `TemplateContext`. That type is a serialized client/server
  contract; the resolver is a server-local capability.

The renderer tests `resolved === undefined` explicitly rather than testing falsiness — a
counter's value is legitimately `0` or negative, and `value ? render : match` would put a
literal `{counter:deaths}` on the live stream at exactly zero deaths.

One change here reaches every template surface: `send_chat`, `show_text`, `tts_speak`,
`llm_response`, `twitch_whisper`, and the timeout reason.

## Stream status

The status line is stored freeform text, not a template, and is read by an unauthenticated
overlay browser source. Handling:

- The stored text keeps its raw `{counter:...}` tokens so it remains editable.
- `StreamStatus.text` — the field the overlay and the `status:updated` broadcast carry —
  is **rendered**. An overlay never receives a raw token and never needs to know counters
  exist.

**Correction to an earlier draft of this spec.** That draft said `StreamStatus` gains a
`rawText` field "returned by the operator-only `GET /api/stream-status`". That route is
**not** operator-only: `auth.ts:32` lists `/api/stream-status` in `OVERLAY_PATHS` and
`auth.ts:124-128` admits an overlay token to GET it. The overlay token lives in an OBS
browser-source URL and is modelled as effectively public. Separately, `realtime.ts`
filters broadcasts by event *name* only — there is no per-field payload filtering — so
`status:updated` would ship any added field verbatim.

Therefore:

- `StreamStatus` — the shape on both `GET /api/stream-status` and the `status:updated`
  broadcast — keeps exactly its current fields, with `text` now rendered. Nothing is added
  to it. Both surfaces are fed from one function so redaction happens once, positionally
  and totally, following the `appConfig.ts` `getInternal()` / `toPublic()` idiom.
- A **new operator-only route**, `GET /api/stream-status/raw`, returns
  `StreamStatusRaw { text, rawText, updatedAt }`. It is deliberately **not** added to
  `OVERLAY_PATHS`.

When a counter changes, `status:updated` is re-broadcast **only if** the stored raw text
actually contains a `{counter:` token. Otherwise every increment would push a status event
to every connected overlay for no reason.

### The round-trip trap

`Dashboard.tsx:404` seeds the Stream Info modal with `status: status.text` and line 425
PUTs that value back via `updateStreamStatus`. Once `text` is rendered, opening the modal
and saving it — **even without touching the status field** — would write the interpolated
text back as the new raw text, permanently replacing `{counter:deaths}` with a snapshot of
its value. This fails silently and is unrecoverable.

The modal must therefore load from `GET /api/stream-status/raw` and seed the form with
`rawText`. A test pins the round-trip: load → save unchanged → stored raw text is byte
identical.

`MAX_STATUS_LENGTH` (280) stays applied to the **raw** input, matching the character
counter in `StreamInfoModal.tsx`. Rendered output may exceed it; that is accepted rather
than truncating a status line mid-number.

This is a contract change, so every producer and consumer is traced: `server/streamStatus.ts`,
`server/auth.ts` (allowlist), `client/streamStatus.ts`, `client/pages/Overlay.tsx`,
`client/pages/Dashboard.tsx`, `client/services/dashboard.ts`.

## Operator surfaces

**Settings → Counters section.** Create, rename, delete, and directly edit the current
value. Direct editing matters: a miscounted death should not require issuing a
compensating chat command.

**`/counter` dashboard slash command:**

- `/counter deaths` — report the current value
- `/counter deaths +1` / `-1` — adjust
- `/counter deaths set 0` — set

Server-owned and executed or rejected server-side, never forwarded to Twitch, per the
existing slash-command rule.

It is a **reserved built-in branch in `handleSlashCommand`**, not a seeded Action. Two
blockers make the Action-backed path impossible, both verified in source:

- **No return channel.** `triggerDispatcher.ts:406-413` synthesizes the response `message`
  from the run *status* alone. An Action's steps cannot write text back into
  `SlashCommandResponse`, so `/counter deaths` could never report a value. (No contract
  change is needed for the built-in: `SlashCommandResponse.run` is already
  `ActionRunResult | null`, so `{ ok: true, message: 'deaths: 41 → 42', run: null }` is
  already legal.)
- **No dynamic target.** `counterId` is a plain string and `mode` is fixed per step, so one
  stored Action addresses exactly one counter in one mode. An Action-less trigger is also
  impossible: `automation_triggers.action_id` is NOT NULL with a foreign key.

The branch is placed **after** the trigger lookup so an operator-created `/counter` trigger
still takes precedence over the built-in.

This is a deliberate, documented exception to the "do not hard-code a command" rule. That
rule exists to stop *viewer* commands from bypassing cooldowns, roles, and dedup; an
operator-only command has none of those. But `+1` and `set` do write, and a built-in
bypasses `automation_runs` entirely — no dedup row, no run log. That tradeoff is recorded
in a comment at the branch.

`ChatInput` currently discards the response message on success (`panels.tsx:387-397`
resolves with `.then(() => setText(''))` and only renders `error`), so it gains a success
line — otherwise `/counter deaths` would report into the void.

**Deletion referencing.** Deleting a counter is rejected, naming the offenders, when it is
referenced by either:

- an `adjust_counter` step (`counterId`), or
- a `{counter:key}` token in **any** step template, or in the stream status raw text.

The second case matters because of an asymmetry: every other token family renders empty
when its value is absent, but an unknown counter key renders **literally**. Without the
template scan, deleting a counter would put a raw `{counter:zambie-deaths}` on the live
stream — exactly what the `{months}`-renders-empty rule was designed to prevent.

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
