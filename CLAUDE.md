# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Narya is being rewritten from a Bun/Express/React/SQLite app into a .NET + Vue 3 app. The
rewrite is in progress under `src/` and `tests/`; the original app is frozen and still runnable
under `legacy/` (its own guidance lives in `legacy/CLAUDE.md`). See `docs/superpowers/plans/` for
the migration roadmap and each phase's detailed implementation plan — that is the source of
truth for what has shipped and what hasn't; do not assume this document tracks phase progress.

## Stack

- **.NET 10** solution (`Narya.sln`), C#, nullable + implicit usings enabled everywhere.
- **Marten** (PostgreSQL) for event-sourced aggregates and inline-snapshot projections.
- **MediatR 13** (pinned) for commands/queries/notifications, with `ValidationBehavior`
  (FluentValidation → `FluentResults.Result.Fail`) and `LoggingBehavior` pipeline behaviors.
- **FluentResults** for expected failures — handlers return `Result`/`Result<T>`, not
  exceptions. Exceptions are for the unexpected; there is no blanket `try/catch → Result.Fail`.
- **PostgreSQL** (event store + documents, via Marten) and **Redis** (cache + realtime pub/sub,
  via StackExchange.Redis), both run locally with `docker compose up -d postgres redis`.
- **ASP.NET SignalR** for realtime delivery to the dashboard and overlays.
- **Vue 3 + Pinia + vue-router + Vite** client (`src/Client`), Bun toolchain, builds straight
  into `Narya.Api/wwwroot` so `dotnet run` always serves the latest client build.
- Tests: **xUnit**, **NSubstitute**, **Testcontainers.PostgreSql/Redis** for real-infrastructure
  integration tests, **Vitest** for the client.

## Commands

```sh
dotnet build Narya.sln              # build everything
dotnet test Narya.sln               # full backend test suite
docker compose up -d postgres redis # local Postgres + Redis for dev/tests
```

```sh
cd src/Client
bun install
bun run dev                         # Vite dev server, proxies /api and /hubs to :5000
bun run test                        # Vitest
bun run typecheck                   # vue-tsc -b --noEmit
bun run build                       # vue-tsc -b && vite build → ../Narya.Api/wwwroot
```

`dotnet run --project src/Narya.Api` serves the API on `http://localhost:5000` (see
`src/Narya.Api/Properties/launchSettings.json`); the Vite dev server proxy in
`src/Client/vite.config.ts` must keep pointing at the same port.

Some integration tests (`Narya.Database.Tests`, `Narya.Cache.Tests`) use Testcontainers and spin
up their own ephemeral Postgres/Redis containers independent of docker-compose — they do not
require compose to be running. `Narya.Api.Tests` uses `Narya:SkipInfrastructure=true` (set via
`IWebHostBuilder.UseSetting`, not `ConfigureAppConfiguration`/`AddInMemoryCollection` — the
latter is not visible to `Program.cs`'s top-level `builder.Configuration.GetValue` read) to run
`WebApplicationFactory` tests with no live Postgres/Redis at all.

## Solution layout

Layers depend downward only; `Narya.Core` defines the ports (interfaces) that outer layers
implement, so `Narya.Application` can depend on persistence/realtime abstractions without
depending on Marten or Redis directly.

```
Narya.Domain       pure records + value objects; no dependencies on anything else in the solution
Narya.Core         ports (I*Store, IRealtimePublisher, ...), shared DTOs, event/notification
                    marker interfaces — depended on by every other layer
Narya.Application  MediatR commands/queries/notifications, folder-per-feature, FluentValidation
                    validators, pipeline behaviors — depends on Core + Domain only
Narya.Database     Marten config, event records, Db*/inline-snapshot projections, *Store
                    implementations of Narya.Core ports — depends on Core + Domain
Narya.Cache        Redis: IRealtimePublisher implementation, cache helpers — depends on Core
Narya.Api          single web host: REST controllers, SignalR hubs, auth middleware, serves the
                    Vue SPA from wwwroot — composes Application + Database + Cache + Core
Narya.Agent        companion console host for the streaming PC (OBS websocket, playerctl,
                    Chatterbox TTS) — connects outbound to Narya.Api over SignalR; must be able
                    to compose Application WITHOUT Database/Cache, so Application registers a
                    no-op IRealtimePublisher default (TryAddSingleton) for hosts that don't
                    also call AddNaryaCache
Client             Vue 3 SPA (src/Client), builds into Narya.Api/wwwroot
```

`tests/Narya.*.Tests` mirror the `src/` projects one-to-one. Composition-root behavior (which
service wins when two layers both register the same interface, whether a host builds without
optional layers, etc.) gets its own test rather than being inferred from end-to-end behavior —
see `tests/Narya.Application.Tests/Realtime/RealtimePublisherCompositionTests.cs` for the
pattern.

## Central package management

Package **versions** are pinned exactly once, in root `Directory.Packages.props`
(`ManagePackageVersionsCentrally`). Individual `.csproj` files use bare
`<PackageReference Include="..." />` with no `Version` attribute. Add a new package version to
`Directory.Packages.props`, not to the consuming project file.

`Directory.Build.props` sets the shared `TargetFramework` (`net10.0`), `Nullable`,
`ImplicitUsings`, and wires Roslynator + NetAnalyzers analyzers for every project.

## Authentication model

Same trust model as `legacy/`: one operator secret, two derived capabilities, no viewer login
(viewers interact only through Twitch chat, handled server-side).

- **Operator token** (`Narya:DashboardToken` config, `ConnectionStrings` sibling in
  `appsettings.json`) — full control. Sent as `Authorization: Bearer <token>` or
  `X-Dashboard-Token`.
- **Overlay token** — derived, not separately stored: `HMAC-SHA256(dashboardToken,
  "narya:overlay:v1")`, hex, first 32 chars (`Narya.Api.Auth.OverlayToken.Derive`, byte-for-byte
  compatible with the legacy Node derivation so existing OBS browser-source URLs keep working
  across the rewrite). Read-only, restricted to an explicit path allowlist
  (`DashboardTokenMiddleware.OverlayPaths`) — `/api/config` is deliberately never on it.
- **No token configured** — the deployment is assumed loopback-only; a request is treated as
  operator only if `HttpContext.Connection.RemoteIpAddress` is a verified loopback address. A
  null remote address (e.g. Kestrel over a Unix socket) fails closed, not open.
- `DashboardTokenAuthenticator` is the single token→role resolution, shared by the HTTP
  middleware and the SignalR hub so the two never drift. Comparison is constant-time
  (`CryptographicOperations.FixedTimeEquals`).

## Coding conventions

- Two-space indentation (matches the analyzer config), `sealed` by default, primary
  constructors for DI-injected dependencies.
- Logging goes through `[LoggerMessage]` source-generated partial methods on a
  `sealed partial class`, not direct `ILogger.LogX(...)` calls (see
  `RealtimeBroadcastService`, `LoggingBehavior`, `RealtimeBridgeHandler`) — avoids the CA1848
  analyzer warning and keeps log call sites allocation-free.
- Client/server payload contracts belong in `Narya.Core` (DTOs) and are what controllers and
  MediatR handlers exchange — don't duplicate a shape between a controller and its handler.
- A realtime event needs its MediatR notification to implement `IRealtimeNotification`
  (`EventName` + `Payload`); `RealtimeBridgeHandler<T>` is the one generic bridge to Redis pub/sub
  for every such notification. It is discovered by MediatR's assembly scan only — do not also
  register it explicitly, or every realtime event double-publishes.
- Realtime publish is deliberately best-effort: it happens after the originating write already
  committed, so a transport failure is logged and swallowed, not surfaced as a 500 (see
  `RealtimeBridgeHandler<T>.Handle`).
- Marten snapshot projection property initializers (`Db*` records in `Narya.Database`) must be
  the domain default, not a bare `""`/`0` literal — that initializer is what an old snapshot
  document deserializes to for a field added in a later phase, not dead code.
- Commits use semantic messages: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:` prefix, short
  imperative description.

## Verification

Baseline after any change: `dotnet build Narya.sln` (0 warnings, 0 errors) and
`dotnet test Narya.sln`. For a client change, also run `bun run test` and `bun run build` from
`src/Client`. Report any check that was not run or could not be completed.

## Workflow

For non-trivial features, write a short plan before implementation. Request confirmation only
when the available choices materially change behavior, architecture, security, or scope.

Superpowers skills write specs and plans under `docs/superpowers/`, and committing them is fine —
no need to relocate them to `.claude/plans/`.

## Code review

When asked to review code, review the code that exists rather than implementing changes unless explicitly requested.

Determine the review mode first:

- **Diff mode** — review the staged diff, working-tree diff, commit, branch, or PR requested by the user. If changes are staged, inspect `git diff --cached`.
- **Codebase mode** — audit the requested repository, module, or directory by architectural blast radius rather than crawling every file equally.

Before reviewing a diff:

- Identify the intended behavior and conceptual scope.
- Set aside generated files, lockfiles, and formatting-only churn.
- Request a split when unrelated concerns make the change unsafe to reason about.
- Trace changed contracts through their producers and consumers. Do not limit review to changed lines when correctness depends on nearby code.
- Verify architectural claims against the current repository; do not assume this document is current.

Review in this order:

1. Correctness and data integrity
2. Security, authentication, authorization, and secret handling
3. Client/server and persistence boundaries
4. Failure behavior and operability
5. Maintainability and readability
6. Performance
7. Style

Every finding must identify a concrete failure mode and cite a file and location. Distinguish observed defects from inferred risks and preferences. Do not report speculative issues as defects.

Use exactly one severity per comment:

- **Blocking** — merge risks data integrity, security, or a durable contract.
- **Should fix** — a demonstrated defect or meaningful architectural erosion.
- **Suggestion** — an optional improvement or preference.
- **Question** — intent cannot be established from available evidence.

Cap suggestions at approximately five. Prioritize material findings over volume. If no material defects are found, say so directly rather than inventing comments.

For substantial changes, ask:

- What invariant or user-visible behavior is being protected?
- What happens on duplicate delivery, repeated rendering, or retry?
- What happens when the operation fails halfway through?
- What happens under concurrent execution?
- Are existing Marten event streams and snapshot documents still readable after a schema change (see the `Db*` projection initializer rule above)?
- Are REST, SignalR, and MediatR notification payload changes compatible with every producer and consumer?
- Can stale asynchronous work overwrite newer state?
- Is authentication and authorization enforced at the backend boundary?
- Could secrets, tokens, chat content, or moderated content be exposed?
- How will a production failure be detected?
- Is the complexity proportional to the requirement?

For a diff review, use this output:

1. A verdict: Approve, Approve with changes, Request changes, Request split, or Unable to determine, followed by one sentence explaining why.
2. Findings grouped by severity, highest first.
3. A verification note stating what was and was not inspected or executed.
4. The one or two most important unanswered questions, when applicable.

For a codebase review, replace the verdict with a concise health summary, report systemic patterns with representative locations and rough instance counts, and order remediation by blast radius.

A review request does not authorize editing, committing, or pushing. If the user asks to fix findings, target the reported defects directly and validate the specific failure paths.

## Preferences

Prefer the simplest approach that preserves the required security and runtime behavior. Do not bypass established OAuth, authorization, secret-storage, or runtime-configuration boundaries merely to reduce implementation size. Ask before introducing materially heavier infrastructure that is not required by the existing architecture.

## Editing

Preserve file encoding and Unicode characters when editing. Inspect the resulting diff for unintended substitutions or normalization changes.

## Commit and PR guidelines

Before handing work back, commit completed changes unless the user asks not to or the work is intentionally in progress.

Keep changes conceptually focused. Judge scope by architectural surface area rather than line count. If unrelated changes cross enough boundaries that correctness cannot be established confidently, split them along those boundaries. Avoid mixing unrelated UI, backend, and config changes in one commit.

Pull requests should include a short summary, the verification commands run, and screenshots for any visible dashboard/tablet/overlay changes. Call out any required `.env`, OBS, Twitch, Postgres, or Redis setup changes.
