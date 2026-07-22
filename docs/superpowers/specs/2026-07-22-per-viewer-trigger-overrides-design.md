# Per-viewer trigger overrides

**Date:** 2026-07-22
**Status:** Approved (Option B of three explored: config-level viewer filter, trigger overrides, step-level variants)

## Problem

The operator wants event responses personalized per viewer with a fallback: when a
specific viewer (e.g. `sorlus`) resubs, play a special clip; for everyone else, the
generic sub alert. The generic alert must not also fire for the personalized viewer
(no double alert), and when the special path cannot run, behavior must degrade to the
generic alert rather than silence.

This is not expressible today:

- `handleTwitchEvent` fires **every** enabled `twitch_event` trigger whose
  `eventKind` matches, sequentially, with no priority or first-match-wins
  (`src/server/triggerDispatcher.ts:324-338`). Same model for rewards and chat.
- Dedup does not help: the dedupe key is `` `${trigger.id}:${eventId}` ``
  (`triggerDispatcher.ts:220`) — deliberately per-trigger, so a second
  "sorlus sub" trigger would fire **in addition to** the generic one.
- Trigger configs are viewer-blind: `TwitchEventTriggerConfig` is `{ eventKind }`,
  `RewardTriggerConfig` is `{ rewardId }` (`src/shared/api.ts:1129-1130`). The
  viewer's lowercased login already reaches the dispatcher on every signal (it
  drives per-user cooldowns and is persisted as `automation_runs.actor_login`) but
  is never used for matching.

## Decision

Introduce a first-class **trigger override**: a row saying "when *this trigger*
fires for *this login*, run *this Action* instead of the trigger's own Action."

The generic trigger stays untouched — it still matches once, passes its own
arming/cooldown gates, and claims its one dedupe key. The override only substitutes
**which** Action that single invocation runs, resolved at the dispatcher's single
`invoke()` choke point. Substitution, not suppression: there is never a second
candidate trigger, so the double alert is structurally unrepresentable.

### Alternatives rejected

- **A — `viewerLogins` filter on trigger config + two-tier dispatch.** Smallest
  diff, but fallback becomes a cross-trigger suppression protocol (generic fires
  only when every specific run was `skipped`) with subtle rules, and the
  full-payload `AutomationTriggerInput` PUT means an editor unaware of the field
  silently strips it. Remains a compatible **future addition** if "fires *only* for
  these viewers, no generic counterpart" is ever needed — a filter narrows *who*
  fires; an override changes *what* runs.
- **C — per-viewer variants inside step payloads.** No dispatcher changes, but
  personalization is content-only (cannot change flow/steps/delays), making one
  viewer special across sub + gift + cheer means editing several Actions, and the
  nested variant editor would be the densest UI in the app.

## Data model

New table in `src/server/db.ts` (idempotent DDL, re-run every boot):

```sql
create table if not exists trigger_overrides (
  id text primary key,
  trigger_id text not null,
  login text not null,              -- lowercased, trimmed, '@'-stripped Twitch login
  action_id text not null,
  enabled integer not null default 1,
  note text not null default '',
  created_at text not null,
  updated_at text not null,
  unique (trigger_id, login),
  foreign key (trigger_id) references automation_triggers(id) on delete cascade,
  foreign key (action_id) references actions(id) on delete cascade
);
create index if not exists idx_trigger_overrides_login on trigger_overrides(login);
```

- `unique (trigger_id, login)` makes "two rules for the same viewer on one
  trigger" a database impossibility, not an application check. Upserts must use
  `insert ... on conflict(trigger_id, login) do update` (check-then-insert races).
- Cascades work because `db.ts` sets `pragma foreign_keys = ON` (db.ts:75).
  Deleting the trigger removes its overrides; deleting the override's Action
  removes the override (viewer reverts to generic).
- **Watch-server guard:** the operator's `bun --watch` persists mid-edit DDL
  shapes into the real database, and `create table if not exists` never heals
  them. Ship a `dropStaleTriggerOverrides(db)` guard next to
  `dropStaleLlmInteractions` (db.ts:62-69): `PRAGMA table_info('trigger_overrides')`,
  and if the table exists with a column set different from the shipped shape, drop
  it so the correct DDL recreates it. The table is operator config that is cheap
  to re-enter; a boot crash is worse.
- No `runOnce` data migration: nothing is derived from existing rows.
  No `addColumnIfMissing` allowlist edits.

## Runtime semantics

All changes are inside `invoke()` in `src/server/triggerDispatcher.ts:237-264`, so
every actor-carrying source (reward, twitch_event, chat_phrase, viewer_command —
and manual runs) gets overrides uniformly. Candidate assembly is untouched.

After the arming and cooldown gates pass, before `claim()`:

1. **Resolve the effective Action.** If `options.actorLogin` is non-empty, one
   indexed point query (new module `src/server/triggerOverrides.ts`):

   ```sql
   select o.id, o.action_id from trigger_overrides o
   join actions a on a.id = o.action_id
   where o.trigger_id = ? and o.login = ? and o.enabled = 1 and a.enabled = 1
   ```

   The join **is** the pre-flight fallback: a disabled override, or a disabled or
   deleted override Action, resolves to nothing and the base `trigger.actionId`
   runs. Empty/absent login (anonymous gifts and cheers dispatch `login: null`)
   skips the lookup entirely — base Action runs.

2. **Claim exactly as today.** Dedupe key stays `` `${trigger.id}:${eventId}` ``:
   one claim per trigger per event regardless of which Action runs. EventSub
   redelivery stays a no-op.

3. **Run, with skip-fallback.** `result = await runAction(effectiveActionId, context)`.
   If an override was applied **and** `result.status === 'skipped'`, run
   `await runAction(trigger.actionId, context)` under the **same** claimed run
   row and record the base run's rolled-up status, with the detail prefixed
   `override for <login> skipped (<detail>); ran base action`. This is safe
   precisely because of the documented executor invariant that a `skipped` run
   broadcasts nothing — the viewer gets the generic alert instead of silence,
   exactly once.

4. **No fallback on `succeeded`, `partial`, or `failed`.** A partial or failed
   override run may already have produced visible output (the banner showed, the
   clip errored); running the base Action would double-play whatever worked.
   Degraded-but-something beats duplicated. An override run that throws follows
   the existing catch path (status `failed`, no fallback).

`TriggerRunSummary.actionId` reports the Action that produced the final result.
Cooldowns need zero changes and are deliberately **shared** with the base trigger:
`isOnCooldown` keys off `trigger.id` + `actor_login`, so a personalized alert
cannot bypass the trigger's throttles, and the override run arms the same
cooldowns. Per-override cooldown tuning is an acknowledged non-feature.

`runTriggerManually` already derives `actorLogin` from `context.login`
(`triggerDispatcher.ts:524`), so `POST /api/automation/triggers/:id/run` with
`{ "login": "sorlus" }` exercises the override path with no further change.

## Contracts (`src/shared/api.ts`)

```ts
export interface TriggerOverride {
  id: string;
  triggerId: string;
  login: string;
  actionId: string;
  enabled: boolean;
  note: string;
  createdAt: string;
  updatedAt: string;
}
// triggerId comes from the route path, so the body cannot disagree with it.
export type TriggerOverrideInput = Omit<TriggerOverride, 'id' | 'triggerId' | 'createdAt' | 'updatedAt'>;
```

- `AutomationTrigger`, its per-kind configs, and `AutomationTriggerInput` are
  **unchanged** — overrides never ride the trigger payload, so the full-input PUT
  round-trip cannot strip them.
- `ViewerFlushResult` gains `overridesRemoved: number` (the `quotesAnonymized`
  precedent: a flush must never edit automation config silently).
- No WebSocket changes. Trigger CRUD has no broadcast events today; overrides
  follow suit (REST + refetch). Nothing touches `OVERLAY_EVENTS`.

## Server module (`src/server/triggerOverrides.ts`)

Leaf module over `db.ts` (importable from both the dispatcher and
`viewerIdentity.ts` without cycles), mirroring the repo + routes shape of
`automationTriggers.ts`:

- Repo: `listOverridesForTrigger(triggerId)`, `resolveOverride(triggerId, login)`
  (the dispatcher's point query), `upsertOverride(input)`,
  `deleteOverride(id)`, `deleteOverridesForLogin(login)` (for flush).
- Routes (registered from `index.ts` beside `registerAutomationTriggerRoutes`,
  same operator-only guard as the other automation routes):
  - `GET  /api/automation/triggers/:id/overrides`
  - `PUT  /api/automation/triggers/:id/overrides` — upsert by login
  - `DELETE /api/automation/overrides/:id`
- Write validation: trigger exists and its kind is one of
  `reward | twitch_event | chat_phrase | viewer_command` (kinds where a real
  actor arrives on the signal); Action exists; login normalized (trim, strip
  leading `@`, lowercase) and matches `/^[a-z0-9_]{1,25}$/`; login not on
  `ignored_logins` — creating an override for a flushed viewer would silently
  reintroduce them into operator config, so it is rejected with a clear message.

## Flush integration

`flushViewer` (`src/server/viewerIdentity.ts:188-206`) gains
`deleteOverridesForLogin(key)` inside its existing transaction and returns the
count; the route surfaces it as `ViewerFlushResult.overridesRemoved`. Deletion,
not anonymization: an override without a login is meaningless, and unlike quote
numbers nothing public circulates. One-way, like quote attribution —
`unflushViewer` cannot restore it.

## UI

All inside the existing trigger editor
(`src/client/pages/settings/AutomationPage.tsx`); because an override is nested
*inside* the trigger it modifies, no cross-trigger "this suppresses that"
visualization is needed — the editor reads "when this fires for **sorlus**, run
*[Sorlus Resub Clip]* instead."

- `TriggerEditor` gains a "Per-viewer overrides" section below `CooldownFields`,
  shown only for overridable kinds via a `supportsOverrides(kind)` helper in
  `settings/automation.ts` (the `supportsCooldowns` pattern, automation.ts:124-126).
- Each row: login, Action `<select>` (same options as "Runs this action",
  including the `(disabled)` suffix convention), enabled toggle, remove button.
  Add-row login input is free text; optional polish is a type-ahead via
  `useDebouncedSuggestions` filtering the already-fetched roster client-side —
  a login not in the roster must still save as typed (the unknown-reward-option
  precedent, AutomationPage.tsx:182-186).
- Overrides save via their own PUT, independent of trigger save — the trigger
  form's validate/save flow is untouched.
- The collapsed trigger list row appends `· N viewer overrides` so a scan shows
  where personalization lives.
- Hint text under the section: "If the override's action can't run (skipped),
  the trigger's normal action plays instead. Cooldowns are shared with this
  trigger."
- Client service layer (`src/client/services/dashboard.ts`): `getTriggerOverrides`,
  `saveTriggerOverride`, `deleteTriggerOverride`.

## Edge cases

| Case | Behavior |
| --- | --- |
| Anonymous gift/cheer (`login: null`) | No lookup; base Action runs. |
| Override Action disabled/deleted | Pre-flight join misses; base runs. FK cascade removes the row on delete. |
| Override run rolls up `skipped` | Base runs under the same run row; detail records the substitution. |
| Override run `partial`/`failed` | No fallback (may have broadcast); run row records it. |
| EventSub redelivery | Same single per-trigger dedupe key; no-op for every path. |
| Module-scoped trigger, module inactive | `isArmed` gate fires before resolution — override rides the trigger. |
| Viewer flushed | Overrides deleted in the flush transaction, counted in the result; PUT rejects ignored logins. |
| Twitch login rename | Override silently stops matching; viewer reverts to generic (fails safe). Threading EventSub `user_id` through the signals is a known future hardening, out of scope. |
| Restart mid-run | No new persisted state; the provisional `failed` run row stands; skip-fallback is synchronous inside one `invoke()`, so a crash between override-skip and base-run leaves `failed`, never a double-fire. |
| "When Sorlus renews" | There is no `resub` event kind — `channel.subscribe` and `channel.subscription.message` both dispatch `'sub'` (`eventsub.ts:195-231`), so the override fires on Sorlus's sub event, first sub or renewal. Months-based discrimination is unreliable (sub-merge race) and deliberately not offered. |
| Two generic triggers each with a sorlus override | Both fire their overridden Actions — identical to two generic triggers both firing today. One mental model: every matching trigger fires once, personalized or not. |

## Known limitations (accepted)

- Cannot express "fire *only* for sorlus with no generic counterpart" — the base
  trigger always fires for everyone. If needed later, add Option A's config-level
  viewer filter; the two compose orthogonally.
- No per-override cooldowns; the special path shares the base trigger's throttles.
- Identity is the login, not the Twitch user id (consistent with cooldowns, tags,
  and the ignore list codebase-wide).

## Testing

- `triggerDispatcher.test.ts`: substitution (override Action runs, base does
  not); pre-flight fallback (disabled override / disabled Action / deleted
  Action); skip-fallback runs base exactly once with prefixed detail; no
  fallback on `partial`/`failed`; anonymous login takes base; cooldown shared
  (override run arms the trigger's cooldowns); redelivery no-op; manual run
  with `{login}` exercises the override.
- `redeemOnce.test.ts`: a redeem by an overridden viewer plays **exactly once**
  (the override clip); a skipped-override fallback plays exactly once (generic).
- `triggerOverrides.test.ts`: validation (kind allowlist, login normalization,
  ignored-login rejection), upsert-on-conflict semantics, cascade behavior.
- `viewerIdentity.test.ts`: flush deletes overrides, reports the count;
  `unflushViewer` does not resurrect them.
- Client `automation.test.ts`: `supportsOverrides`, list-row description.

## Verification

`bun run typecheck`, `bun test`, `bun run build`; smoke-test the new routes and
`POST /api/automation/triggers/:id/run` with `{ "login": "sorlus" }` against a
scratch `STREAMER_TOOLS_DB`; visible dashboard check of the overrides editor.
