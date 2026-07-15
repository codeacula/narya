# Quick Disable + Master Media Mute — Design

**Date:** 2026-07-15
**Status:** Approved (design), pending implementation plan

## Problem

During a stream, a viewer can spam a sound/video chat command (e.g. `!fart`) and there
is no fast way to make Narya ignore further requests. The operator wants a single button
on the tablet (and dashboard) that silences the noise-making commands on demand, while
leaving channel-point **redemptions** working. Today the only lever is editing each
`viewer_command` trigger's `enabled` flag in Settings — too slow for a live spam wave.

## Solution overview

Two cooperating pieces:

1. **Quick Disable** — a per-Action opt-in flag (checkbox in the Actions editor). It marks
   an Action as one the master mute is allowed to silence.
2. **Master media mute** — a single persisted, global toggle surfaced in Stream Controls on
   both the dashboard and the tablet. While engaged, every Quick-Disable-flagged Action is
   silenced; every unflagged Action runs normally.

The operator keeps a redemption alive during a mute by **not** flagging its Action. If a
command and a redeem literally share one Action, flagging that Action silences both — this
is the accepted trade-off (the flag lives on the Action, not the trigger).

### Confirmed decisions

- **Granularity:** one master mute button (not per-command buttons).
- **Target:** the flag lives on the **Action**; the master mute acts **only** on
  Quick-Disable-flagged Actions (opt-in), never on unflagged Actions.
- **Persistence:** the mute state persists across a Narya restart and shows lit on the
  tablet, so a mid-stream restart does not silently un-mute.
- **Manual runs:** while muted, a manual run of a flagged Action is **also suppressed**
  (a panic button should not have an exception). Manual runs of unflagged Actions are
  unaffected.

## Architecture

### Enforcement — single choke point

The mute is enforced at the top of `runAction` in `src/server/actionExecutor.ts`:

```
if isMediaMuted() and action.quickDisable:
    return a `skipped` ActionRunResult   # broadcast nothing
```

- Reuses the existing invariant that **a skipped run broadcasts nothing** — no
  `media:play`, no `overlay:text`, so overlays stay quiet with zero overlay-allowlist
  changes.
- Because it sits in the executor (below the dispatcher), **every** invocation source —
  `viewer_command`, `reward`, `manual`, module lifecycle — honors the mute uniformly.
  There is no second code path to keep in sync, and no new play path, so
  `src/server/redeemOnce.test.ts` stays valid.
- The mute is read through an **injected getter** (`isMediaMuted: () => boolean`) added to
  the executor's dependencies and wired in the `automation.ts` composition root, matching
  the existing "media resolution is an injected port" pattern. The executor does not import
  the mute module directly (avoids an import cycle).

### Persisted mute state

A dedicated, minimal store — deliberately **off** the `app_config` / Settings path, so a
mute never triggers a Twitch/OBS reconnect and never rides the credentials save.

- New module `src/server/mediaMute.ts` exposing `getMediaMuted(): boolean` and
  `setMediaMuted(muted: boolean): void`.
- Schema (idempotent, single-row) added to `db.ts`:
  ```sql
  create table if not exists media_mute (
    id integer primary key check (id = 1),
    muted integer not null default 0
  );
  ```
  A `getMediaMuted()` that finds no row returns `false`; `setMediaMuted` upserts row id 1.
  This survives restart (the persistence requirement) — unlike the in-memory overlay
  placeholder flag, which is intentionally memory-only and is **not** reused here.

### Backend routes

Registered alongside the other automation routes (operator-only; `requireDashboardToken`
already gates `/api`). The overlay GET-only token is **not** granted access — a browser
source has no business reading or flipping this.

- `GET  /api/automation/media-mute` → `{ muted: boolean }`
- `PUT  /api/automation/media-mute` (body `{ muted: boolean }`) → persists via
  `setMediaMuted`, then `broadcast('media:mute', { muted })`, returns `{ muted }`.

`media:mute` is **not** added to `OVERLAY_EVENTS` — it carries operator control state and
overlays must never receive it.

### Per-Action flag

- New column via `addColumnIfMissing('actions', 'quick_disable', 'integer not null default 0')`
  in `db.ts` (idempotent, re-runs safely every boot).
- `src/server/actions.ts`: add `quickDisable` to `ACTION_COLUMNS` select, `rowToAction`
  (`row.quickDisable === 1`), `normalizeActionUpsert` (`typeof value.quickDisable === 'boolean' ? … : false`),
  and both the insert and update statements/transactions.

### Shared contracts (`src/shared/api.ts`)

- `Action` and `ActionUpsert` gain `quickDisable: boolean`.
- New `MediaMuteState = { muted: boolean }` for the REST payload and the `media:mute`
  WebSocket event.

### Frontend surfaces

- **Actions editor** (`src/client/pages/settings/ActionsPage.tsx`): a "Quick Disable"
  checkbox per Action, mirroring how the existing `enabled` flag is edited. Labelled so the
  operator understands it means "the master mute can silence this Action."
- **Dashboard** (`ControlsPanel` in `src/client/ui/panels.tsx`): a lit "Mute sound/video
  commands" toggle that mirrors `OverlayPlaceholderToggle` — seed via `GET`, flip via `PUT`,
  and subscribe to `media:mute` so other tabs / the tablet stay in sync. Shown visibly
  "engaged" (e.g. red) while muted.
- **Tablet** (`src/client/pages/Tablet.tsx`, Stream Controls column): a prominent button,
  lit red when muted, sharing the same state + `media:mute` subscription.
- A small dashboard service wrapper (`getMediaMute` / `setMediaMute`) alongside the existing
  overlay-placeholder helpers.

## Data flow

1. Operator taps the mute button (tablet or dashboard) → `PUT /api/automation/media-mute`.
2. Server persists to `media_mute` and broadcasts `media:mute { muted: true }`.
3. All operator surfaces update their lit state from the broadcast.
4. A viewer types `!fart` → `viewer_command` trigger matches → dispatcher invokes the Action
   → `runAction` sees `isMediaMuted() && action.quickDisable` → returns `skipped`, broadcasts
   nothing. Overlay stays silent.
5. A channel-point redeem whose Action is **not** flagged fires normally.
6. Operator taps again → `{ muted: false }` → Actions resume.
7. On restart, `getMediaMuted()` reads the persisted row → the button comes back lit if it
   was muted.

## Failure & edge behavior

- **Skipped, not failed:** a muted invocation is `skipped` (nothing ran by choice), matching
  the existing status semantics; the `automation_runs` log records it truthfully.
- **Cooldowns/dedup unaffected:** the mute short-circuits inside `runAction`, after the
  dispatcher has already claimed its dedupe row, so a redelivery while muted still cannot
  double-fire once un-muted (its dedupe key is already spent). This is acceptable — a muted
  event is genuinely handled.
- **Concurrent toggles:** last write wins; the broadcast reconciles every surface. No partial
  state (single boolean).
- **Unflagged Actions:** never touched by the mute, so alerts and redemptions the operator
  cares about keep working.

## Testing

- **Executor** (`actionExecutor` test): flagged Action + muted → `skipped`, no broadcast;
  flagged + un-muted → runs; unflagged + muted → runs.
- **Persistence** (`mediaMute` test, in-memory DB under `NODE_ENV=test`): `setMediaMuted(true)`
  then `getMediaMuted()` returns `true`; default with no row returns `false`.
- **Actions repository:** round-trip `quickDisable` through create/read/update.
- **Regression:** `redeemOnce.test.ts` remains green (no new play path introduced).
- Baseline `bun run typecheck` and `bun run build`; visible tablet/dashboard check that the
  button lights and a flagged command goes silent while an unflagged redeem still plays.

## Out of scope

- Per-command / per-trigger individual mute buttons (explicitly not chosen).
- Auto-unmute timers or scheduled mutes.
- Muting non-media Actions (the flag is general-purpose, but the intent and UI copy target
  sound/video commands).
