# Project Check-In & Roadmap — 2026-07-23

Status: Active roadmap
Author: Codeacula (with Claude)

## Context

Periodic health check on Narya to decide what to re-review, refactor, and build next.
Findings below come from a read-only sweep of test coverage, complexity, and git/doc
trajectory. Overall the codebase is healthy and well-disciplined; the work items are at
the edges, not the core.

## Health snapshot

**Strong:**
- ~1,100 tests across 67 colocated files; every high-risk module named in CLAUDE.md is covered
  (trigger dispatcher, trigger overrides, category modules, wind-down, quotes, viewer identity,
  redeem media).
- Source hygiene near-spotless: 0 TODO/FIXME/HACK, 0 `@ts-ignore`/`as any`, no lint suppressions.
- `src/server/index.ts` is a clean 189-line composition root. `twitch/api.ts` and `db.ts` are
  large but cohesive.

**Weak spots:**
- No CI, no pre-commit hooks — tests/typecheck/build only run when someone remembers.
- Twitch integration layer untested: `twitch/api.ts` (850 lines) and `twitch/auth.ts` (436, OAuth)
  have zero colocated tests. Also untested: `dashboard/status.ts` (741), `viewerRewards.ts` (507).
- `src/client/ui/panels.tsx` is a 1,646-line god-file bundling ~15 unrelated panels.
- Per-module duplication of `normalize*` / `validate*` / `asHttpError` helpers across ~9 route modules.
- `/settings` is a routing dead end — direct navigation renders the Dashboard (unknown paths fall
  through in `main.tsx`).
- `feature-validation.md` register (last validated 2026-06-23, stale) lists shipped-but-unverified
  surfaces requiring live externals: AutoMod hold queue, live Twitch auth/EventSub/ads/moderation,
  real OBS scene switching, LLM against a live endpoint, audible audio playback.
- Several `docs/superpowers/specs/` status headers are stale (say "not implemented" for shipped work).

## Chosen workstreams & sequence

The user selected three workstreams. Recommended order (safest/most foundational first):

### 1. Split `panels.tsx` (refactor — first)
Break the 1,646-line file into one-file-per-panel plus a `modules.ts` registry. Isolated,
reversible, no external dependencies. De-risks later UI work.

### 2. Test the Twitch layer (stability — second)
Backfill colocated tests for `src/server/twitch/api.ts` and `src/server/twitch/auth.ts`. Foundational
before the Redis arc leans on `twitch/api.ts`. Consider `dashboard/status.ts` and `viewerRewards.ts`
as follow-ons.

### 3. Redis automation arc (new direction — third, needs its own design cycle)
The designed-but-unstarted next major initiative (`2026-07-20-redis-automation-arc-design.md`).
Recent per-viewer overrides + LLM Action context work was Phase B pre-work. Phases A/C/D
(redis.ts, `ioredis`, provenance columns, app registry, inbound consumer) are unbuilt. This gets a
fresh brainstorm → spec → plan cycle rather than being folded into this roadmap.

## Enabling side-tasks (do alongside, not blocking)
- **CI on Forgejo:** Forgejo Actions is GitHub-Actions-compatible. Add a workflow under
  `.forgejo/workflows/` running `bun install`, `bun run typecheck`, `bun test`, `bun run build` on
  push/PR. Requires a registered Forgejo runner.
- Extract shared `validation` / `httpError` helper module (widest-blast-radius cleanup; do
  opportunistically while touching route modules).
- Refresh stale spec status headers and `feature-validation.md`.
- Fix the `/settings` direct-navigation routing gap.

## Not doing (yet)
- `categoryModules.ts` split (638 lines, invariant-heavy) — worthwhile but defer until it's being
  touched for another reason; the risk/reward doesn't justify a standalone effort now.
- Reducer extraction on form-heavy pages (ActionsPage, AutomationPage, ViewerRewardsPage) — only if
  they keep growing.
