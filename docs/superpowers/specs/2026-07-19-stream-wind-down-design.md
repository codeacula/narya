# Stream Wind-Down Mode — Design

Date: 2026-07-19
Status: Approved design, ready for implementation planning

## Origin and the constraint that reshaped it

The original request was: manually turn off incoming raids, let an Action turn them
off, set a planned end-of-stream time on the go-live Info screen, and automatically
block raids some configurable number of minutes before that time.

**Twitch exposes no way to do the blocking part.** This was researched against the
official docs and adversarially verified; it is a settled negative, not an
unknown:

- No Helix endpoint reads or writes the channel's incoming-raid settings. Asked
  directly on the developer forum whether one exists, a Twitch forum moderator's
  complete answer was "No there isn't"
  ([thread 41736](https://discuss.dev.twitch.com/t/api-endpoint-for-raid-settings/41736)).
  A [2025 request](https://discuss.dev.twitch.com/t/api-to-toggle-allow-raids-setting-streamer-mods-support/64036)
  was redirected to UserVoice rather than answered with an existing endpoint.
- `channel:manage:raids` grants exactly two endpoints, `POST /helix/raids` and
  `DELETE /helix/raids`. Both are **outbound** — start a raid, cancel a raid.
- There is no chat command. IRC slash commands were removed on 24 February 2023.
- **Shield Mode is not a substitute.** The docs describe it as applying "the
  overrides that the broadcaster configured in the Twitch UX" — an opaque
  container, not a fixed behavior. No endpoint reads which overrides a channel's
  Shield Mode applies, and the `channel.shield_mode.begin`/`.end` EventSub events
  carry no information about what was applied. Building on it means shipping a
  control whose effect cannot be observed or predicted. Explicitly rejected.
- Twitch's own dashboard drives the raid toggle through the private
  `gql.twitch.tv` endpoint using the operator's **web session cookie**. That is
  outside the OAuth boundary this project maintains and conflicts with the
  credential-handling rules in CLAUDE.md. Explicitly rejected.

One useful note on provenance: Twitch's Creator Dashboard has a quick action
called **"Stop Raids for 1 Hour"**, time-boxed at 60 minutes. That is the real
feature behind the original request's instinct that a longer window would need
repeating. It has no API; the standing UserVoice ticket for it is titled "stop
raids for an hour as an api."

### The reframe

If a raid cannot be prevented, the next best thing is to **tell a prospective
raider before they commit**. Someone deciding whether to raid is looking at the
channel title and the stream itself — both fully under Narya's control.

The feature is therefore renamed from "Block Incoming Raids" to **Wind-Down
Mode**. The switch no longer claims an effect it cannot deliver.

### Explicitly out of scope

**Raid alert suppression is not part of this feature.** It was considered and
rejected by the operator: a raid arriving five minutes before the end is more
worth celebrating, not less. The full celebration path — overlay banner, sound,
shoutout — runs unchanged during wind-down. No option, no toggle, no setting;
an option nobody should enable is a maintenance burden with no upside.

## What Wind-Down Mode is

A persisted boolean with a reason, which can be turned on three ways (manually,
on a schedule, or by an Action) and which produces exactly two effects while on:
a Twitch title suffix, and an overlay countdown.

## Components

### 1. Planned end time

`stream_sessions.planned_end_at` — nullable RFC3339 text, added via
`addColumnIfMissing` (the existing idempotent helper, `db.ts:587`). Null for
rows predating the column and for sessions with no plan, matching how
`stream_events.session_id` handles the same situation.

Set from the go-live Info screen, and editable mid-stream from the dashboard.
Mid-stream editing is required, not a nicety: streams run over, and a wind-down
that fires while the operator is still going with no way to push it back is
worse than no feature.

Cleared implicitly when the session ends (the row is closed).

### 2. Wind-down state

Follows the `media_mute` template (`db.ts:348`) — a single-row table, REST
GET/PUT, and a WebSocket broadcast:

```sql
create table if not exists wind_down (
  id integer primary key check (id = 1),
  active integer not null default 0,
  activated_at text,
  source text,              -- 'manual' | 'scheduled' | 'action'
  session_id text,          -- the session this activation belongs to
  base_title text,          -- the pre-wind-down Twitch title, for restore
  dismissed_session_id text -- see "manual off must stick"
);
```

`base_title` is persisted rather than held in memory specifically so a restart
cannot strand a suffixed title (see Failure Modes).

Broadcast event: `winddown:updated`, carrying `{ active, source, plannedEndAt }`.

**The overlay needs this event**, so `winddown:updated` must be added to
`OVERLAY_EVENTS` in `src/server/auth.ts`. It carries no operator configuration —
an active flag, a source string, and a timestamp — so it is safe on that
allowlist. The REST **GET** goes on `OVERLAY_PATHS` so a source can seed itself;
the **PUT stays operator-only**, exactly as `overlay:placeholders` is arranged.

### 3. The scheduler

Modeled directly on `automaticAds.ts`: a pure decision function plus a thin tick
loop, so the logic is testable without timers or network.

```ts
export function evaluateWindDown(input: {
  now: number;
  plannedEndAt: string | null;
  leadMinutes: number;
  sessionId: string | null;
  streamActive: boolean;
  state: WindDownState;
}): WindDownDecision;  // { action: 'activate' | 'none', reason: string }
```

The caller owns the actual Twitch call and the persistence. Same split as
`evaluateAdSchedule` (`automaticAds.ts:28`), which keeps the interesting logic
in a function that takes a number for `now`.

Started from `index.ts` alongside `startAutomaticAds`.

### 4. The effects

#### a. Title suffix

Appends a configurable suffix to the Twitch title, e.g. `| Ending ~9pm`.

Uses `channel:manage:broadcast`, **already granted** (`twitch/auth.ts:18`). No
re-authorization is needed for any part of this feature.

**It must call `PATCH /helix/channels` directly, not the app's own
`PATCH /api/twitch/stream-info` route.** That route (`twitch/api.ts:712`)
requires a category alongside the title and calls `onCategorySignal` on every
success — routing a title tweak through it would re-fire category-module
switching as a side effect of the clock hitting a number. Wind-down sends only
`{ title }`.

**Title length.** Twitch caps titles at 140 characters. If
`base_title + suffix` exceeds 140, the update is rejected and would otherwise
fail silently at the worst possible moment. Rule: if the combined length exceeds
140, **truncate the base title** (on a word boundary where possible, with an
ellipsis) so the suffix always survives — the suffix is the entire point of the
operation. If the suffix alone exceeds 140, reject it at configuration time in
Settings rather than at 9pm.

#### b. Overlay notice and countdown

A new browser source at `/overlay/winddown`, registered in `OVERLAY_BY_PATH` in
`src/client/routing.ts` and covered in `routing.test.ts`.

It receives `plannedEndAt` over the socket and **ticks down client-side**, so the
countdown stays smooth without per-second server traffic.

Display defaults to **relative** (`~25 min left`) rather than absolute. Relative
reads friendlier to a viewer and avoids leaking the operator's timezone.

Per the overlay rules in CLAUDE.md: transparent background, fixed-position
region, no app chrome. `OverlayPlaceholder` is attached once in `main.tsx`'s
overlay branch, so this source gets its positioning outline automatically.

### 5. Manual and Action control

- **Dashboard** — a quick-action toggle, following the `mediaMute` control.
- **Action step** — a new `set_wind_down` step type added to `ActionStepType`
  (`src/shared/api.ts:714`), payload `{ active: boolean }`.

The Action step covers the original request's "an action that turns it off"
directly: that is a step with `active: false`. Because slash commands are already
Actions and server-owned, a `/winddown` command comes for free — no client-side
parsing, per the slash-command rule in CLAUDE.md.

### 6. Configuration

New `app_config` keys, added to `DEFAULTS` in `appConfig.ts:16`:

| Key | Default | Meaning |
|---|---|---|
| `windDownLeadMinutes` | `15` | How long before planned end to activate |
| `windDownTitleSuffix` | `\| Ending soon` | Appended to the title |
| `windDownTitleEnabled` | `true` | Whether to touch the title at all |
| `windDownOverlayEnabled` | `true` | Whether the overlay renders |

Edited in Settings. No `.env` reads — per CLAUDE.md, `.env` seeds nothing.

## Failure modes and the rules that address them

These are the cases that would make the feature actively annoying. Each is a
design requirement, not a nice-to-have.

**Title restore after a restart.** A naive implementation holds the original
title in memory; Narya restarts mid-wind-down and `| Ending soon` is welded to
the title into the next stream. `base_title` is therefore persisted in the
`wind_down` row, and reconciled on boot: if `active` is set at startup, the
stored base title is authoritative.

**No double-append.** The title is always computed as `base_title + suffix`,
never appended to whatever is currently live. Toggling twice cannot stack
suffixes.

**Manual off must stick.** If the operator turns wind-down off by hand at
T-minus-10, the scheduler must not switch it straight back on at the next tick.
`dismissed_session_id` latches the dismissal for the remainder of that stream
session. This is the single easiest thing here to get wrong, and getting it
wrong makes the feature unusable.

**Running over does not undo it.** Once the planned end passes, wind-down stays
active rather than expiring. It does not re-fire.

**Operator edits the title during wind-down.** A stream-info update while
wind-down is active re-bases: the newly submitted title becomes `base_title` and
the suffix is re-applied on top, rather than the operator's edit being clobbered
or the suffix being lost.

**Stream ends while active.** Clear wind-down and restore `base_title`.

**Twitch unreachable when activating.** The overlay effect still applies; the
title update is retried on the next tick rather than leaving the state
inconsistent. A failed title update never blocks the overlay.

## Testing

- `evaluateWindDown` — pure-function unit tests covering each decision branch:
  before the window, inside it, already active, manually dismissed, no planned
  end, stream offline, planned end already passed. No timers.
- Title composition — including the 140-character truncation path and the
  no-double-append property.
- `routing.test.ts` — `/overlay/winddown` resolves to its source and, critically,
  does not fall through to the dashboard.
- Restart reconciliation — an active row at boot restores rather than strands.
- The step executor — `set_wind_down` in both directions.

## Open questions

None. The Shield Mode question was closed by the operator's decision to skip it
regardless of its configuration.
