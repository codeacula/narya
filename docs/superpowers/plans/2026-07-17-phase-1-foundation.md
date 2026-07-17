# Phase 1: Foundation + AppConfig Vertical Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the Narya C# solution (Marten event sourcing, MediatR 13 with pipeline behaviors, Redis→SignalR realtime bridge, operator/overlay token auth) and prove it end-to-end with one event-sourced vertical slice: the runtime AppConfig, plus a Vue 3 scaffold that reads it.

**Architecture:** Apollo-style layered solution (Domain → Core → Application → Database/Cache → Api) with the deviations recorded in the roadmap (no EF, no gRPC, CPM, pipeline behaviors, event auto-registration, Testcontainers). The legacy Bun app moves intact to `legacy/` and stays runnable until cutover.

**Tech Stack:** .NET 10, MediatR 13.0.0, Marten 8.18.0, StackExchange.Redis 2.10.1, FluentResults 4.0.0, FluentValidation 12.0.0, xUnit 2.9.3, NSubstitute, Testcontainers 4.4.0, Vue 3 + Vite 7 + Pinia + @microsoft/signalr (Bun toolchain).

## Global Constraints

- MediatR pinned at **13.0.0** (user requirement; do not upgrade to 14 without asking).
- Target framework **net10.0** everywhere; `Nullable` and `ImplicitUsings` enabled.
- All package versions live in `Directory.Packages.props` only — no versions in csproj files.
- Result-returning MediatR requests: `IRequest<Result<T>>` (FluentResults). No blanket `catch (Exception) → Result.Fail` — expected failures only; unexpected exceptions bubble.
- Secrets never serialize to the client: config responses expose `*Configured` booleans (match legacy `GET /api/config` behavior).
- Legacy app in `legacy/` must remain runnable (`cd legacy && bun test`) until cutover.
- Commit style: `feat:`/`chore:`/`test:` prefixes, imperative, ending with the Claude Code trailer.
- The new SPA is served by Narya.Api; Vue builds into `src/Narya.Api/wwwroot` (gitignored).

## File Structure (created this phase)

```
Narya.sln
Directory.Build.props / Directory.Packages.props / .editorconfig
docker-compose.yaml
src/Narya.Domain/       NaryaDomain.cs (marker), AppConfig/AppConfig.cs
src/Narya.Core/         NaryaCore.cs (marker), AppConfig/IAppConfigStore.cs,
                        AppConfig/AppConfigResponse.cs, Realtime/IRealtimePublisher.cs,
                        Realtime/RealtimeEventNames.cs
src/Narya.Application/  NaryaApplication.cs, Behaviors/ValidationBehavior.cs,
                        Behaviors/LoggingBehavior.cs, AppConfig/GetAppConfigQuery.cs,
                        AppConfig/UpdateAppConfigCommand.cs,
                        AppConfig/Notifications/AppConfigNotifications.cs
src/Narya.Database/     NaryaDatabase.cs, ServiceCollectionExtensions.cs,
                        Common/INaryaEvent.cs, Common/EventRegistration.cs,
                        AppConfig/Events/AppConfigEvents.cs, AppConfig/DbAppConfig.cs,
                        AppConfig/AppConfigStore.cs
src/Narya.Cache/        NaryaCache.cs, RealtimePublisher.cs, ServiceCollectionExtensions.cs
src/Narya.Api/          Program.cs, Auth/NaryaAuthOptions.cs, Auth/DashboardTokenMiddleware.cs,
                        Auth/OverlayToken.cs, Realtime/RealtimeHub.cs,
                        Realtime/RealtimeBroadcastService.cs, Controllers/HealthController.cs,
                        Controllers/ConfigController.cs, appsettings.json
src/Client/             Vite Vue 3 app (src/services/auth.ts, src/services/api.ts,
                        src/services/realtime.ts, src/stores/configStore.ts,
                        src/views/HealthView.vue, router, App.vue)
tests/Narya.Database.Tests/   Fixtures/PostgresFixture.cs, AppConfig/AppConfigStoreTests.cs,
                              Common/EventRegistrationTests.cs
tests/Narya.Application.Tests/ Behaviors/ValidationBehaviorTests.cs,
                               AppConfig/UpdateAppConfigCommandTests.cs
tests/Narya.Api.Tests/         Auth/DashboardTokenMiddlewareTests.cs,
                               Controllers/ConfigControllerTests.cs
.github/workflows/dotnet-build-test.yml
legacy/                 (entire current app, moved)
```

---

### Task 1: Move the legacy app to `legacy/`

**Files:**
- Move: `src/`, `package.json`, `bun.lock`, `tsconfig.json`, `vite.config.ts`, `index.html`, `public/`, `scripts/` (if present) → `legacy/`
- Modify: `.gitignore` (prefix legacy-specific entries)

**Interfaces:**
- Consumes: nothing.
- Produces: a repo root free for the .NET solution; legacy runnable via `cd legacy && bun run dev`.

- [ ] **Step 1: Inventory what must move**

Run: `ls /home/codeacula/Storage/Projects/narya` and `git ls-files | cut -d/ -f1 | sort -u`
Everything app-specific moves; `CLAUDE.md`, `docs/`, `.claude/`, `.github/`, `.gitignore`, `data/` (untracked), `.env` (untracked) stay at root.

- [ ] **Step 2: Move tracked files with git mv**

```bash
mkdir legacy
git mv src package.json bun.lock tsconfig.json vite.config.ts index.html legacy/
# public/ is partially gitignored (public/clips) — move tracked part with git mv, rest with mv:
git mv public legacy/public || { mv public legacy/public && git add -A legacy/public; }
```

- [ ] **Step 3: Update .gitignore paths**

Edit `.gitignore`: any pattern referencing `dist/`, `public/clips`, `data/` gains a `legacy/` prefix where the path moved (keep `data/` at root — the operator's live DB stays put; legacy reads it via `STREAMER_TOOLS_DB` or by symlink `ln -s ../data legacy/data`).

- [ ] **Step 4: Verify legacy still works**

```bash
cd legacy && bun install && bun run typecheck && bun test
```
Expected: typecheck clean, all 39 test files pass (in-memory DB under NODE_ENV=test).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "chore: move Bun app to legacy/ ahead of C# rewrite"
```

---

### Task 2: Solution scaffold with central package management

**Files:**
- Create: `Narya.sln`, `Directory.Build.props`, `Directory.Packages.props`, `.editorconfig`, all `src/Narya.*/Narya*.csproj` + marker classes, all `tests/Narya.*.Tests/*.csproj`

**Interfaces:**
- Produces: marker types `Narya.Domain.NaryaDomain`, `Narya.Core.NaryaCore`, `Narya.Application.NaryaApplication`, `Narya.Database.NaryaDatabase`, `Narya.Cache.NaryaCache` (used for assembly scanning by later tasks). Project references: Core→Domain; Application→Core,Domain; Database→Core,Domain; Cache→Core; Api→Application,Database,Cache,Core.

- [ ] **Step 1: Create solution and projects**

```bash
cd /home/codeacula/Storage/Projects/narya
dotnet new sln -n Narya
for p in Domain Core Application Database Cache; do dotnet new classlib -n Narya.$p -o src/Narya.$p; done
dotnet new web -n Narya.Api -o src/Narya.Api
dotnet new console -n Narya.Agent -o src/Narya.Agent
for p in Domain Core Application Database Cache Api Agent; do dotnet new xunit -n Narya.$p.Tests -o tests/Narya.$p.Tests 2>/dev/null; done
dotnet sln add src/*/*.csproj tests/*/*.csproj
dotnet add src/Narya.Core reference src/Narya.Domain
dotnet add src/Narya.Application reference src/Narya.Core src/Narya.Domain
dotnet add src/Narya.Database reference src/Narya.Core src/Narya.Domain
dotnet add src/Narya.Cache reference src/Narya.Core
dotnet add src/Narya.Api reference src/Narya.Application src/Narya.Database src/Narya.Cache
for p in Domain Core Application Database Cache Api Agent; do dotnet add tests/Narya.$p.Tests reference src/Narya.$p; done
```

- [ ] **Step 2: Write Directory.Build.props**

```xml
<Project>
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <AnalysisLevel>latest</AnalysisLevel>
    <EnforceCodeStyleInBuild>true</EnforceCodeStyleInBuild>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Roslynator.Analyzers" PrivateAssets="all" />
    <PackageReference Include="Microsoft.CodeAnalysis.NetAnalyzers" PrivateAssets="all" />
  </ItemGroup>
  <PropertyGroup Condition="$(MSBuildProjectName.EndsWith('.Tests'))">
    <IsPackable>false</IsPackable>
  </PropertyGroup>
</Project>
```

- [ ] **Step 3: Write Directory.Packages.props**

```xml
<Project>
  <PropertyGroup>
    <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
  </PropertyGroup>
  <ItemGroup>
    <PackageVersion Include="MediatR" Version="13.0.0" />
    <PackageVersion Include="Marten" Version="8.18.0" />
    <PackageVersion Include="Marten.AspNetCore" Version="8.18.0" />
    <PackageVersion Include="StackExchange.Redis" Version="2.10.1" />
    <PackageVersion Include="FluentResults" Version="4.0.0" />
    <PackageVersion Include="FluentValidation" Version="12.0.0" />
    <PackageVersion Include="FluentValidation.DependencyInjectionExtensions" Version="12.0.0" />
    <PackageVersion Include="Roslynator.Analyzers" Version="4.15.0" />
    <PackageVersion Include="Microsoft.CodeAnalysis.NetAnalyzers" Version="10.0.102" />
    <PackageVersion Include="xunit" Version="2.9.3" />
    <PackageVersion Include="xunit.runner.visualstudio" Version="3.1.0" />
    <PackageVersion Include="Microsoft.NET.Test.Sdk" Version="18.0.1" />
    <PackageVersion Include="NSubstitute" Version="5.3.0" />
    <PackageVersion Include="coverlet.collector" Version="6.0.4" />
    <PackageVersion Include="Testcontainers.PostgreSql" Version="4.4.0" />
    <PackageVersion Include="Testcontainers.Redis" Version="4.4.0" />
    <PackageVersion Include="Microsoft.AspNetCore.Mvc.Testing" Version="10.0.0" />
    <PackageVersion Include="Microsoft.AspNetCore.SignalR.Client" Version="10.0.0" />
    <PackageVersion Include="Microsoft.Extensions.Hosting" Version="10.0.0" />
  </ItemGroup>
</Project>
```
Then strip `Version=` attributes the templates put into every csproj (CPM forbids them):
`grep -rl 'PackageReference.*Version=' src tests` and edit each hit.
Verify current patch versions on NuGet (`dotnet package search MediatR --exact-match`); update this file — **except MediatR stays 13.0.0**.

- [ ] **Step 4: Marker classes + .editorconfig**

One marker per project, e.g. `src/Narya.Domain/NaryaDomain.cs`:
```csharp
namespace Narya.Domain;

/// <summary>Assembly marker for Narya.Domain.</summary>
public static class NaryaDomain;
```
Repeat for Core/Application/Database/Cache (`NaryaCore`, `NaryaApplication`, `NaryaDatabase`, `NaryaCache`). Copy Apollo's `.editorconfig` (`/home/codeacula/Storage/Projects/apollo/.editorconfig`) as the starting point (2-space indent, LF, file-scoped namespaces, 120 cols).

- [ ] **Step 5: Build and commit**

```bash
dotnet build Narya.sln
```
Expected: `Build succeeded. 0 Warning(s). 0 Error(s).`
```bash
git add -A && git commit -m "feat: scaffold Narya .NET solution with central package management"
```

---

### Task 3: Dev infrastructure (docker-compose) + configuration conventions

**Files:**
- Create: `docker-compose.yaml`, `.env.example`, `src/Narya.Api/appsettings.json`

**Interfaces:**
- Produces: connection strings `ConnectionStrings:Narya` (Postgres) and `ConnectionStrings:Redis`; auth settings `Narya:DashboardToken`.

- [ ] **Step 1: Write docker-compose.yaml** (dev profile: infra only; app containers come at cutover)

```yaml
services:
  postgres:
    image: postgres:17-alpine
    environment:
      POSTGRES_DB: narya
      POSTGRES_USER: narya
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-narya-dev}
    ports: ["5432:5432"]
    volumes: [pgdata:/var/lib/postgresql/data]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U narya"]
      interval: 5s
      timeout: 3s
      retries: 10
  redis:
    image: redis:alpine
    command: ["redis-server", "--requirepass", "${REDIS_PASSWORD:-narya-dev}"]
    ports: ["6379:6379"]
volumes:
  pgdata:
```

- [ ] **Step 2: appsettings.json + .env.example**

`src/Narya.Api/appsettings.json`:
```json
{
  "ConnectionStrings": {
    "Narya": "Host=localhost;Port=5432;Database=narya;Username=narya;Password=narya-dev",
    "Redis": "localhost:6379,password=narya-dev"
  },
  "Narya": { "DashboardToken": "" },
  "Logging": { "LogLevel": { "Default": "Information", "Microsoft.AspNetCore": "Warning" } }
}
```
`.env.example` documents the double-underscore overrides (`ConnectionStrings__Narya`, `Narya__DashboardToken`) for the eventual server deploy. Real secrets: `dotnet user-secrets` (add `<UserSecretsId>narya-api</UserSecretsId>` to Narya.Api.csproj).

- [ ] **Step 3: Verify + commit**

```bash
docker compose up -d postgres redis
docker compose ps   # expect postgres healthy, redis running
git add -A && git commit -m "chore: add postgres/redis dev compose and API config conventions"
```

---

### Task 4: Testcontainers integration harness + Marten smoke test

**Files:**
- Create: `tests/Narya.Database.Tests/Fixtures/PostgresFixture.cs`, `tests/Narya.Database.Tests/MartenSmokeTests.cs`
- Modify: `tests/Narya.Database.Tests/Narya.Database.Tests.csproj` (add Marten, Testcontainers.PostgreSql), `src/Narya.Database/Narya.Database.csproj` (add Marten)

**Interfaces:**
- Produces: `PostgresFixture : IAsyncLifetime` exposing `string ConnectionString` and `DocumentStore CreateStore(Action<StoreOptions>? configure = null)`. Collection name: `"postgres"`. All later Database tests consume this fixture.

- [ ] **Step 1: Write the fixture**

```csharp
using Marten;
using Testcontainers.PostgreSql;

namespace Narya.Database.Tests.Fixtures;

public sealed class PostgresFixture : IAsyncLifetime
{
  private readonly PostgreSqlContainer _container = new PostgreSqlBuilder()
    .WithImage("postgres:17-alpine")
    .Build();

  public string ConnectionString => _container.GetConnectionString();

  public DocumentStore CreateStore(Action<StoreOptions>? configure = null) =>
    DocumentStore.For(options =>
    {
      options.Connection(ConnectionString);
      configure?.Invoke(options);
    });

  public Task InitializeAsync() => _container.StartAsync();
  public Task DisposeAsync() => _container.DisposeAsync().AsTask();
}

[CollectionDefinition("postgres")]
public sealed class PostgresCollection : ICollectionFixture<PostgresFixture>;
```

- [ ] **Step 2: Write the failing smoke test**

```csharp
using Narya.Database.Tests.Fixtures;

namespace Narya.Database.Tests;

[Collection("postgres")]
public sealed class MartenSmokeTests(PostgresFixture fixture)
{
  private sealed record Doc(Guid Id, string Name);

  [Fact]
  public async Task StoresAndLoadsADocument()
  {
    await using var store = fixture.CreateStore();
    await using var session = store.LightweightSession();
    var doc = new Doc(Guid.NewGuid(), "hello");
    session.Store(doc);
    await session.SaveChangesAsync();

    await using var query = store.QuerySession();
    var loaded = await query.LoadAsync<Doc>(doc.Id);
    Assert.Equal("hello", loaded!.Name);
  }
}
```

- [ ] **Step 3: Run (fails: packages missing), add packages, run again**

```bash
dotnet test tests/Narya.Database.Tests   # FAIL: Marten/Testcontainers not referenced
dotnet add src/Narya.Database package Marten
dotnet add tests/Narya.Database.Tests package Marten
dotnet add tests/Narya.Database.Tests package Testcontainers.PostgreSql
dotnet test tests/Narya.Database.Tests
```
Expected: PASS (needs Docker running).

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "test: add Testcontainers postgres fixture with Marten smoke test"
```

---

### Task 5: MediatR 13 wiring + pipeline behaviors

**Files:**
- Create: `src/Narya.Application/Behaviors/ValidationBehavior.cs`, `src/Narya.Application/Behaviors/LoggingBehavior.cs`, `src/Narya.Application/ServiceCollectionExtensions.cs`
- Test: `tests/Narya.Application.Tests/Behaviors/ValidationBehaviorTests.cs`

**Interfaces:**
- Consumes: `NaryaApplication` marker (Task 2).
- Produces: `services.AddNaryaApplication()` — registers MediatR (assembly scan), all validators, and both open-generic behaviors. Requests are `IRequest<Result<T>>`; a validator failure returns `Result.Fail` without invoking the handler.

- [ ] **Step 1: Write the failing tests**

```csharp
using FluentResults;
using FluentValidation;
using MediatR;
using Microsoft.Extensions.DependencyInjection;
using Narya.Application.Behaviors;

namespace Narya.Application.Tests.Behaviors;

public sealed record EchoCommand(string Text) : IRequest<Result<string>>;

public sealed class EchoValidator : AbstractValidator<EchoCommand>
{
  public EchoValidator() => RuleFor(x => x.Text).NotEmpty().WithMessage("text is required");
}

public sealed class EchoHandler : IRequestHandler<EchoCommand, Result<string>>
{
  public static bool WasCalled;
  public Task<Result<string>> Handle(EchoCommand request, CancellationToken ct)
  {
    WasCalled = true;
    return Task.FromResult(Result.Ok(request.Text));
  }
}

public sealed class ValidationBehaviorTests
{
  private static IMediator BuildMediator() => new ServiceCollection()
    .AddLogging()
    .AddSingleton<IValidator<EchoCommand>, EchoValidator>()
    .AddMediatR(cfg =>
    {
      cfg.RegisterServicesFromAssemblyContaining<ValidationBehaviorTests>();
      cfg.AddOpenBehavior(typeof(ValidationBehavior<,>));
    })
    .BuildServiceProvider()
    .GetRequiredService<IMediator>();

  [Fact]
  public async Task InvalidRequestFailsWithoutReachingHandler()
  {
    EchoHandler.WasCalled = false;
    var result = await BuildMediator().Send(new EchoCommand(""));
    Assert.True(result.IsFailed);
    Assert.Contains(result.Errors, e => e.Message == "text is required");
    Assert.False(EchoHandler.WasCalled);
  }

  [Fact]
  public async Task ValidRequestReachesHandler()
  {
    var result = await BuildMediator().Send(new EchoCommand("hi"));
    Assert.True(result.IsSuccess);
    Assert.Equal("hi", result.Value);
  }
}
```

- [ ] **Step 2: Run to verify failure**

```bash
dotnet add src/Narya.Application package MediatR
dotnet add src/Narya.Application package FluentResults
dotnet add src/Narya.Application package FluentValidation
dotnet add src/Narya.Application package FluentValidation.DependencyInjectionExtensions
dotnet add tests/Narya.Application.Tests package NSubstitute
dotnet test tests/Narya.Application.Tests
```
Expected: FAIL — `ValidationBehavior` does not exist.

- [ ] **Step 3: Implement ValidationBehavior**

```csharp
using FluentResults;
using FluentValidation;
using MediatR;

namespace Narya.Application.Behaviors;

public sealed class ValidationBehavior<TRequest, TResponse>(IEnumerable<IValidator<TRequest>> validators)
  : IPipelineBehavior<TRequest, TResponse>
  where TRequest : notnull
  where TResponse : ResultBase, new()
{
  public async Task<TResponse> Handle(
    TRequest request, RequestHandlerDelegate<TResponse> next, CancellationToken cancellationToken)
  {
    var errors = new List<IError>();
    foreach (var validator in validators)
    {
      var validation = await validator.ValidateAsync(request, cancellationToken);
      errors.AddRange(validation.Errors.Select(e => (IError)new Error(e.ErrorMessage)));
    }

    if (errors.Count == 0)
    {
      return await next(cancellationToken);
    }

    var failed = new TResponse();
    failed.Reasons.AddRange(errors);
    return failed;
  }
}
```
Note: `Result<T>` has a public parameterless constructor and adding `IError` reasons flips `IsFailed` — the test proves this; if a FluentResults version change breaks it, construct via `Result.Fail(errors).ToResult<T>()` reflection-free helpers instead.

`LoggingBehavior` (same folder): log request type name at Debug before `next(...)`, log `IsFailed` + error messages at Warning after. Constructor: `ILogger<LoggingBehavior<TRequest, TResponse>> logger`. Constraints: `where TRequest : notnull where TResponse : ResultBase`.

- [ ] **Step 4: ServiceCollectionExtensions**

```csharp
using FluentValidation;
using Microsoft.Extensions.DependencyInjection;
using Narya.Application.Behaviors;

namespace Narya.Application;

public static class ServiceCollectionExtensions
{
  public static IServiceCollection AddNaryaApplication(this IServiceCollection services)
  {
    _ = services.AddValidatorsFromAssemblyContaining<NaryaApplication>();
    _ = services.AddMediatR(cfg =>
    {
      _ = cfg.RegisterServicesFromAssemblyContaining<NaryaApplication>();
      _ = cfg.AddOpenBehavior(typeof(LoggingBehavior<,>));
      _ = cfg.AddOpenBehavior(typeof(ValidationBehavior<,>));
    });
    return services;
  }
}
```

- [ ] **Step 5: Test, then commit**

```bash
dotnet test tests/Narya.Application.Tests   # expect PASS (2 tests)
git add -A && git commit -m "feat: wire MediatR 13 with validation and logging pipeline behaviors"
```

---

### Task 6: Event contract + auto-registration

**Files:**
- Create: `src/Narya.Database/Common/INaryaEvent.cs`, `src/Narya.Database/Common/EventRegistration.cs`
- Test: `tests/Narya.Database.Tests/Common/EventRegistrationTests.cs`

**Interfaces:**
- Produces: `INaryaEvent { Guid EventId; DateTimeOffset OccurredAt; }` — every domain event record implements it (fixes Apollo's inconsistent BaseEvent). `StoreOptions.RegisterNaryaEvents(Assembly)` scans and calls `Events.AddEventType` for each concrete `INaryaEvent` (fixes Apollo's hand-maintained, incomplete event list).

- [ ] **Step 1: Failing test**

```csharp
using Marten;
using Narya.Database.Common;

namespace Narya.Database.Tests.Common;

public sealed record ProbeEvent(Guid EventId, DateTimeOffset OccurredAt) : INaryaEvent;

public sealed class EventRegistrationTests
{
  [Fact]
  public void RegistersEveryConcreteNaryaEventInTheAssembly()
  {
    var options = new StoreOptions();
    options.Connection("Host=unused");
    options.RegisterNaryaEvents(typeof(ProbeEvent).Assembly);
    Assert.Contains(options.Events.AllKnownEventTypes(),
      m => m.EventType == typeof(ProbeEvent));
  }
}
```
(If `AllKnownEventTypes()` differs in Marten 8.18, use `options.EventGraph.AllEvents()` — check with the installed package; the assertion intent is "the mapping exists".)

- [ ] **Step 2: Run → FAIL (types missing). Implement:**

`INaryaEvent.cs`:
```csharp
namespace Narya.Database.Common;

public interface INaryaEvent
{
  Guid EventId { get; }
  DateTimeOffset OccurredAt { get; }
}
```
`EventRegistration.cs`:
```csharp
using System.Reflection;
using Marten;

namespace Narya.Database.Common;

public static class EventRegistration
{
  public static void RegisterNaryaEvents(this StoreOptions options, Assembly assembly)
  {
    var eventTypes = assembly.GetTypes()
      .Where(t => t is { IsClass: true, IsAbstract: false } && t.IsAssignableTo(typeof(INaryaEvent)));
    foreach (var type in eventTypes)
    {
      options.Events.AddEventType(type);
    }
  }
}
```

- [ ] **Step 3: Test + commit**

```bash
dotnet test tests/Narya.Database.Tests --filter EventRegistrationTests   # PASS
git add -A && git commit -m "feat: add INaryaEvent contract with assembly-scan event registration"
```

---

### Task 7: AppConfig aggregate (events, projection, store)

**Files:**
- Create: `src/Narya.Domain/AppConfig/AppConfig.cs`, `src/Narya.Core/AppConfig/IAppConfigStore.cs`, `src/Narya.Database/AppConfig/Events/AppConfigEvents.cs`, `src/Narya.Database/AppConfig/DbAppConfig.cs`, `src/Narya.Database/AppConfig/AppConfigStore.cs`, `src/Narya.Database/ServiceCollectionExtensions.cs`
- Test: `tests/Narya.Database.Tests/AppConfig/AppConfigStoreTests.cs`

**Interfaces:**
- Consumes: `PostgresFixture` (Task 4), `INaryaEvent` + `RegisterNaryaEvents` (Task 6).
- Produces:
  - `Narya.Domain.AppConfig.AppConfig` — record with `required init` props: `string TwitchClientId, TwitchClientSecret, TwitchChannel, TwitchBotUsername, ObsWebsocketUrl, ObsWebsocketPassword, DiscordBotToken, ChatterboxUrl, ObsScenePrefix` (all default `""`), `int MusicPollIntervalMs` (2000), `int SoundVolumePercent` (100), `int MusicVolumePercent` (100). **At execution, diff this list against `legacy/src/server/appConfig.ts` `DEFAULTS` and add any field present there — the legacy file is authoritative for parity.**
  - `IAppConfigStore { Task<Result<AppConfig>> GetAsync(CancellationToken); Task<Result<AppConfig>> UpdateAsync(AppConfigPatch patch, CancellationToken); }` where `AppConfigPatch` is the same shape with every property nullable (null = unchanged) — mirrors legacy PUT semantics where omitted secrets are preserved.
  - `services.AddNaryaDatabase(string connectionString)`.
  - Single-stream aggregate keyed by `AppConfigStore.RootId = Guid.Parse("00000000-0000-0000-0000-000000000001")` (Apollo `ConfigurationId.Root` pattern).

- [ ] **Step 1: Failing store test**

```csharp
using Narya.Database.AppConfig;
using Narya.Database.Tests.Fixtures;

namespace Narya.Database.Tests.AppConfig;

[Collection("postgres")]
public sealed class AppConfigStoreTests(PostgresFixture fixture)
{
  private AppConfigStore BuildStore()
  {
    var store = fixture.CreateStore(NaryaMartenConfig.Configure); // shared config helper, see Step 3
    return new AppConfigStore(store);
  }

  [Fact]
  public async Task GetReturnsDefaultsWhenNoStreamExists()
  {
    var result = await BuildStore().GetAsync(CancellationToken.None);
    Assert.True(result.IsSuccess);
    Assert.Equal("", result.Value.TwitchClientId);
    Assert.Equal(2000, result.Value.MusicPollIntervalMs);
  }

  [Fact]
  public async Task UpdateAppendsEventAndProjectsNewState()
  {
    var store = BuildStore();
    var updated = await store.UpdateAsync(
      new AppConfigPatch { TwitchChannel = "codeacula", SoundVolumePercent = 80 },
      CancellationToken.None);
    Assert.True(updated.IsSuccess);

    var reloaded = await store.GetAsync(CancellationToken.None);
    Assert.Equal("codeacula", reloaded.Value.TwitchChannel);
    Assert.Equal(80, reloaded.Value.SoundVolumePercent);
    Assert.Equal("", reloaded.Value.TwitchClientSecret); // untouched fields keep defaults
  }

  [Fact]
  public async Task NullPatchFieldsPreserveExistingValues()
  {
    var store = BuildStore();
    _ = await store.UpdateAsync(new AppConfigPatch { TwitchClientSecret = "s3cret" }, CancellationToken.None);
    _ = await store.UpdateAsync(new AppConfigPatch { TwitchChannel = "codeacula" }, CancellationToken.None);
    var result = await store.GetAsync(CancellationToken.None);
    Assert.Equal("s3cret", result.Value.TwitchClientSecret);
    Assert.Equal("codeacula", result.Value.TwitchChannel);
  }
}
```

- [ ] **Step 2: Run → FAIL. Implement domain + events + projection.**

`AppConfigEvents.cs` — one event; each field nullable (null = not changed by this event):
```csharp
using Narya.Database.Common;

namespace Narya.Database.AppConfig.Events;

public sealed record AppConfigUpdatedEvent : INaryaEvent
{
  public const int SchemaVersion = 1;
  public required Guid EventId { get; init; }
  public required DateTimeOffset OccurredAt { get; init; }
  public string? TwitchClientId { get; init; }
  public string? TwitchClientSecret { get; init; }
  public string? TwitchChannel { get; init; }
  public string? TwitchBotUsername { get; init; }
  public string? ObsWebsocketUrl { get; init; }
  public string? ObsWebsocketPassword { get; init; }
  public string? DiscordBotToken { get; init; }
  public string? ChatterboxUrl { get; init; }
  public string? ObsScenePrefix { get; init; }
  public int? MusicPollIntervalMs { get; init; }
  public int? SoundVolumePercent { get; init; }
  public int? MusicVolumePercent { get; init; }
}
```
`DbAppConfig.cs` — Marten self-aggregating snapshot (Apollo `Db*` pattern) with
`static DbAppConfig Create(IEvent<AppConfigUpdatedEvent>)` and
`static DbAppConfig Apply(IEvent<AppConfigUpdatedEvent>, DbAppConfig)` using
`ev.Data.X ?? current.X` per field, plus `public static explicit operator AppConfig(DbAppConfig)`.
`AppConfigStore.cs`:
```csharp
using FluentResults;
using Marten;
using Narya.Core.AppConfig;
using Narya.Database.AppConfig.Events;
using DomainConfig = Narya.Domain.AppConfig.AppConfig;

namespace Narya.Database.AppConfig;

public sealed class AppConfigStore(IDocumentStore store) : IAppConfigStore
{
  public static readonly Guid RootId = Guid.Parse("00000000-0000-0000-0000-000000000001");

  public async Task<Result<DomainConfig>> GetAsync(CancellationToken cancellationToken)
  {
    await using var session = store.QuerySession();
    var db = await session.LoadAsync<DbAppConfig>(RootId, cancellationToken);
    return Result.Ok(db is null ? new DomainConfig() : (DomainConfig)db);
  }

  public async Task<Result<DomainConfig>> UpdateAsync(AppConfigPatch patch, CancellationToken cancellationToken)
  {
    var ev = patch.ToEvent(Guid.NewGuid(), DateTimeOffset.UtcNow);
    await using var session = store.LightweightSession();
    var exists = await session.Events.FetchStreamStateAsync(RootId, cancellationToken);
    if (exists is null)
    {
      _ = session.Events.StartStream<DbAppConfig>(RootId, ev);
    }
    else
    {
      _ = session.Events.Append(RootId, ev);
    }
    await session.SaveChangesAsync(cancellationToken);
    return await GetAsync(cancellationToken);
  }
}
```
(`AppConfigPatch.ToEvent` is a straight field copy living beside the patch in Narya.Core; `DomainConfig` needs a parameterless-constructible shape, so give the domain record property defaults instead of `required`.)

- [ ] **Step 3: Shared Marten config + DI**

`ServiceCollectionExtensions.cs` in Narya.Database:
```csharp
using Marten;
using JasperFx.Events.Projections; // verify namespace for SnapshotLifecycle in Marten 8.18
using Microsoft.Extensions.DependencyInjection;
using Narya.Core.AppConfig;
using Narya.Database.AppConfig;
using Narya.Database.Common;

namespace Narya.Database;

public static class ServiceCollectionExtensions
{
  public static IServiceCollection AddNaryaDatabase(this IServiceCollection services, string connectionString)
  {
    _ = services.AddMarten(options =>
      {
        options.Connection(connectionString);
        NaryaMartenConfig.Configure(options);
      })
      .UseLightweightSessions();
    services.AddSingleton<IAppConfigStore, AppConfigStore>();
    return services;
  }
}

public static class NaryaMartenConfig
{
  public static void Configure(StoreOptions options)
  {
    options.RegisterNaryaEvents(typeof(NaryaDatabase).Assembly);
    _ = options.Projections.Snapshot<DbAppConfig>(SnapshotLifecycle.Inline);
  }
}
```
The tests and the host share `NaryaMartenConfig.Configure` so test Marten == production Marten.

- [ ] **Step 4: Test + commit**

```bash
dotnet test tests/Narya.Database.Tests   # PASS (smoke + registration + 3 store tests)
git add -A && git commit -m "feat: event-sourced AppConfig aggregate with inline snapshot projection"
```

---

### Task 8: AppConfig application layer (query, command, secret-masked response)

**Files:**
- Create: `src/Narya.Core/AppConfig/AppConfigResponse.cs`, `src/Narya.Application/AppConfig/GetAppConfigQuery.cs`, `src/Narya.Application/AppConfig/UpdateAppConfigCommand.cs`, `src/Narya.Application/AppConfig/Notifications/AppConfigNotifications.cs`
- Test: `tests/Narya.Application.Tests/AppConfig/UpdateAppConfigCommandTests.cs`

**Interfaces:**
- Consumes: `IAppConfigStore`, `AppConfigPatch` (Task 7); MediatR wiring (Task 5).
- Produces:
  - `AppConfigResponse` — the client-safe shape: plain fields for non-secrets (`TwitchChannel`, `ObsWebsocketUrl`, `ChatterboxUrl`, `ObsScenePrefix`, `MusicPollIntervalMs`, `SoundVolumePercent`, `MusicVolumePercent`, `TwitchClientId`) and **booleans only** for secrets: `TwitchClientSecretConfigured`, `ObsWebsocketPasswordConfigured`, `DiscordBotTokenConfigured`. Static `AppConfigResponse.From(AppConfig)`.
  - `GetAppConfigQuery : IRequest<Result<AppConfigResponse>>` (+ handler).
  - `UpdateAppConfigCommand(AppConfigPatch Patch) : IRequest<Result<AppConfigResponse>>` (+ validator: `MusicPollIntervalMs` null-or-`InclusiveBetween(250, 60000)`, volumes null-or-`InclusiveBetween(0, 100)`; + handler that updates the store then `mediator.Publish(new AppConfigUpdatedNotification())`).
  - `AppConfigUpdatedNotification : INotification, IRealtimeNotification` with `string EventName => "settings:updated"` and `object Payload` (see Task 10's `IRealtimeNotification`; define the interface in Narya.Core/Realtime **in this task** so both compile: `interface IRealtimeNotification { string EventName { get; } object Payload { get; } }`).

- [ ] **Step 1: Failing tests** (NSubstitute the store; command+query in one test class)

```csharp
using FluentResults;
using MediatR;
using NSubstitute;
using Narya.Application.AppConfig;
using Narya.Core.AppConfig;
using DomainConfig = Narya.Domain.AppConfig.AppConfig;

namespace Narya.Application.Tests.AppConfig;

public sealed class UpdateAppConfigCommandTests
{
  [Fact]
  public async Task MasksSecretsInTheResponse()
  {
    var store = Substitute.For<IAppConfigStore>();
    store.UpdateAsync(Arg.Any<AppConfigPatch>(), Arg.Any<CancellationToken>())
      .Returns(Result.Ok(new DomainConfig { TwitchClientSecret = "s3cret", TwitchChannel = "codeacula" }));
    var handler = new UpdateAppConfigCommandHandler(store, Substitute.For<IMediator>());

    var result = await handler.Handle(
      new UpdateAppConfigCommand(new AppConfigPatch { TwitchChannel = "codeacula" }), CancellationToken.None);

    Assert.True(result.IsSuccess);
    Assert.True(result.Value.TwitchClientSecretConfigured);
    Assert.Equal("codeacula", result.Value.TwitchChannel);
    var serialized = System.Text.Json.JsonSerializer.Serialize(result.Value);
    Assert.DoesNotContain("s3cret", serialized);   // the load-bearing assertion
  }

  [Fact]
  public async Task PublishesSettingsUpdatedNotification()
  {
    var store = Substitute.For<IAppConfigStore>();
    store.UpdateAsync(Arg.Any<AppConfigPatch>(), Arg.Any<CancellationToken>())
      .Returns(Result.Ok(new DomainConfig()));
    var mediator = Substitute.For<IMediator>();
    var handler = new UpdateAppConfigCommandHandler(store, mediator);

    _ = await handler.Handle(new UpdateAppConfigCommand(new AppConfigPatch()), CancellationToken.None);

    await mediator.Received(1).Publish(Arg.Any<AppConfigUpdatedNotification>(), Arg.Any<CancellationToken>());
  }
}
```

- [ ] **Step 2: Run → FAIL. Implement** query, command, validator, handler (command + handler in one file, Apollo style), `AppConfigResponse.From`, notification, `IRealtimeNotification`.

- [ ] **Step 3: Test + commit**

```bash
dotnet test tests/Narya.Application.Tests   # PASS
git add -A && git commit -m "feat: AppConfig query/command with secret-masked response contract"
```

---

### Task 9: API host, token auth middleware, health endpoint

**Files:**
- Create: `src/Narya.Api/Auth/NaryaAuthOptions.cs`, `src/Narya.Api/Auth/OverlayToken.cs`, `src/Narya.Api/Auth/DashboardTokenMiddleware.cs`, `src/Narya.Api/Controllers/HealthController.cs`; rewrite `src/Narya.Api/Program.cs`
- Test: `tests/Narya.Api.Tests/Auth/DashboardTokenMiddlewareTests.cs`

**Interfaces:**
- Consumes: `AddNaryaApplication()` (Task 5), `AddNaryaDatabase(cs)` (Task 7).
- Produces:
  - `NaryaAuthOptions { string DashboardToken }` bound from `Narya:DashboardToken`.
  - `OverlayToken.Derive(string dashboardToken)` → first 32 hex chars of HMAC-SHA256 over `"narya:overlay:v1"` — **byte-identical to legacy** `getOverlayToken` (`legacy/src/server/auth.ts`); the derivation is part of the operator's existing OBS setup and must not change.
  - Middleware semantics (port of legacy `requireDashboardToken`): token from `Authorization: Bearer`, `X-Dashboard-Token`, or `?token=`; constant-time compare (`CryptographicOperations.FixedTimeEquals`); roles `operator` (everything) / `overlay` (GET only + allowlist `OVERLAY_PATHS`: `/api/health`, `/api/config` **excluded** — start the allowlist with `/api/health` only and grow it per phase) / anonymous → 401 JSON `{ "code": "INVALID_DASHBOARD_TOKEN" }`. Empty configured token → loopback-only operator mode (403 for non-loopback remote addresses).
  - `HttpContext.Items["narya:role"]` set to `"operator"`/`"overlay"` for downstream handlers.
  - `GET /api/health` → `{ "ok": true }` (overlay-allowed).
  - Program.cs wires: options, middleware, controllers, `AddNaryaApplication`, `AddNaryaDatabase`, static SPA fallback (wwwroot + index.html fallback excluding `/api` and `/hubs`).

- [ ] **Step 1: Failing WebApplicationFactory tests**

```csharp
using System.Net;
using System.Net.Http.Headers;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Microsoft.AspNetCore.Hosting;

namespace Narya.Api.Tests.Auth;

public sealed class DashboardTokenMiddlewareTests
{
  private static HttpClient BuildClient(string configuredToken) =>
    new WebApplicationFactory<Program>()
      .WithWebHostBuilder(b => b.ConfigureAppConfiguration((_, cfg) =>
        cfg.AddInMemoryCollection(new Dictionary<string, string?>
        {
          ["Narya:DashboardToken"] = configuredToken,
          ["Narya:SkipInfrastructure"] = "true", // Program.cs guard: no Marten/Redis in these tests
        })))
      .CreateClient();

  [Fact]
  public async Task MissingTokenIs401WithCode()
  {
    var response = await BuildClient("op-token").GetAsync("/api/health");
    Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    Assert.Contains("INVALID_DASHBOARD_TOKEN", await response.Content.ReadAsStringAsync());
  }

  [Fact]
  public async Task OperatorBearerTokenPasses()
  {
    var client = BuildClient("op-token");
    client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", "op-token");
    var response = await client.GetAsync("/api/health");
    Assert.Equal(HttpStatusCode.OK, response.StatusCode);
  }

  [Fact]
  public async Task OverlayTokenReachesAllowlistedGetOnly()
  {
    var overlay = Narya.Api.Auth.OverlayToken.Derive("op-token");
    var client = BuildClient("op-token");
    var ok = await client.GetAsync($"/api/health?token={overlay}");
    Assert.Equal(HttpStatusCode.OK, ok.StatusCode);
    var forbidden = await client.GetAsync($"/api/config?token={overlay}");
    Assert.Equal(HttpStatusCode.Forbidden, forbidden.StatusCode);
  }
}
```

- [ ] **Step 2: Run → FAIL. Implement.** `OverlayToken`:

```csharp
using System.Security.Cryptography;
using System.Text;

namespace Narya.Api.Auth;

public static class OverlayToken
{
  public static string Derive(string dashboardToken)
  {
    using var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(dashboardToken));
    var hash = hmac.ComputeHash(Encoding.UTF8.GetBytes("narya:overlay:v1"));
    return Convert.ToHexStringLower(hash)[..32];
  }
}
```
**Cross-check against legacy before trusting this:** run `cd legacy && bun -e 'import("./src/server/auth.ts")'`-style REPL or read `getOverlayToken` to confirm key/message order (legacy: `createHmac('sha256', DASHBOARD_TOKEN).update('narya:overlay:v1')`), then add a unit test asserting a known token → known derived value produced by the legacy code.

Middleware + Program.cs per the Produces block. Add `public partial class Program;` at the bottom of Program.cs for WebApplicationFactory. Guard infra registration: `if (!builder.Configuration.GetValue<bool>("Narya:SkipInfrastructure")) { AddNaryaDatabase(...); AddNaryaCache(...); }`.

- [ ] **Step 3: Also expose `GET /api/auth/overlay-token`** (operator-only): returns `{ "token": OverlayToken.Derive(configured) }`; 404 when no token configured. Add a test asserting overlay role gets 403 on it.

- [ ] **Step 4: Test + commit**

```bash
dotnet add tests/Narya.Api.Tests package Microsoft.AspNetCore.Mvc.Testing
dotnet test tests/Narya.Api.Tests   # PASS
git add -A && git commit -m "feat: API host with operator/overlay token auth and health endpoint"
```

---

### Task 10: Config endpoints + Redis→SignalR realtime bridge

**Files:**
- Create: `src/Narya.Api/Controllers/ConfigController.cs`, `src/Narya.Core/Realtime/IRealtimePublisher.cs`, `src/Narya.Core/Realtime/RealtimeEventNames.cs`, `src/Narya.Cache/RealtimePublisher.cs`, `src/Narya.Cache/ServiceCollectionExtensions.cs`, `src/Narya.Api/Realtime/RealtimeHub.cs`, `src/Narya.Api/Realtime/RealtimeBroadcastService.cs`, `src/Narya.Application/Realtime/RealtimeBridgeHandler.cs`
- Test: `tests/Narya.Api.Tests/Controllers/ConfigControllerTests.cs`, `tests/Narya.Cache.Tests/RealtimePublisherTests.cs` (Testcontainers.Redis)

**Interfaces:**
- Consumes: `GetAppConfigQuery`/`UpdateAppConfigCommand` (Task 8), auth middleware (Task 9), `IRealtimeNotification` (Task 8).
- Produces:
  - `GET /api/config` → 200 `AppConfigResponse`; `PUT /api/config` body = `AppConfigPatch` → 200 updated response or 400 with validation errors (map `Result.IsFailed` from the validation behavior to 400 `{ errors: [...] }`).
  - `IRealtimePublisher { Task PublishAsync(string eventName, object payload, CancellationToken ct); }` — publishes JSON `{ event, payload }` to Redis channel `narya:realtime`.
  - `RealtimeBridgeHandler : INotificationHandler<INotification>` — no: one **generic** handler `class RealtimeBridgeHandler<T>(IRealtimePublisher publisher) : INotificationHandler<T> where T : IRealtimeNotification, INotification` registered open-generic, replacing Apollo's 22-method fan-in.
  - `RealtimeHub` at `/hubs/realtime`: on connect, run the same token→role logic (token via `access_token` query string); role `overlay` joins group `overlay`, `operator` joins groups `operator` **and** `overlay` (operators see everything). Reject unauthenticated.
  - `RealtimeBroadcastService : BackgroundService` — subscribes `narya:realtime`, forwards to SignalR: events in `RealtimeEventNames.OverlayAllowlist` (starts as `["settings:updated"]`? **No** — `settings:updated` is operator-only in legacy; allowlist starts **empty**, operator group receives everything) → operator group always, overlay group only if allowlisted. Method name on the client: `"event"` with `(string eventName, JsonElement payload)`.
- [ ] **Step 1: Failing controller test** (SkipInfrastructure mode + NSubstitute `IMediator` via service override): asserts GET returns masked shape; PUT with `musicPollIntervalMs: 10` returns 400.

```csharp
// tests/Narya.Api.Tests/Controllers/ConfigControllerTests.cs — same WebApplicationFactory pattern as Task 9,
// override IAppConfigStore with a substitute registered in ConfigureTestServices; assert:
// 1. GET /api/config (operator) → 200, body contains "twitchClientSecretConfigured", never a secret value
// 2. PUT /api/config {"musicPollIntervalMs":10} → 400 (validator floor 250)
// 3. GET /api/config with overlay token → 403 (config is NOT overlay-allowlisted)
```

- [ ] **Step 2: Failing Redis publisher test** (Testcontainers.Redis): publish via `RealtimePublisher`, subscribe with a raw `ConnectionMultiplexer`, assert the `{event,payload}` envelope round-trips.

- [ ] **Step 3: Implement all files from the Produces block; register `AddNaryaCache(cs)` (Redis multiplexer singleton + publisher) and hub/background service in Program.cs (behind the SkipInfrastructure guard).**

- [ ] **Step 4: Manual smoke** (needs compose up):

```bash
Narya__DashboardToken=dev-token dotnet run --project src/Narya.Api &
curl -s -H 'Authorization: Bearer dev-token' http://localhost:5000/api/health
curl -s -H 'Authorization: Bearer dev-token' http://localhost:5000/api/config | grep -i configured
curl -s -X PUT -H 'Authorization: Bearer dev-token' -H 'Content-Type: application/json' \
  -d '{"twitchChannel":"codeacula"}' http://localhost:5000/api/config
```
Expected: health ok; config shows `*Configured` booleans; PUT echoes the updated channel.

- [ ] **Step 5: Test + commit**

```bash
dotnet test   # full solution PASS
git add -A && git commit -m "feat: config REST endpoints and Redis-to-SignalR realtime bridge"
```

---

### Task 11: Vue 3 scaffold with auth + config view

**Files:**
- Create: `src/Client/` (Vite Vue-TS app): `vite.config.ts`, `src/services/auth.ts`, `src/services/api.ts`, `src/services/realtime.ts`, `src/stores/configStore.ts`, `src/views/HealthView.vue`, `src/router/index.ts`, `src/App.vue`, `src/__tests__/auth.spec.ts`

**Interfaces:**
- Consumes: `/api/health`, `/api/config`, `/hubs/realtime` (Tasks 9–10).
- Produces: `bun run build` in `src/Client` emits into `../Narya.Api/wwwroot`; `captureDashboardToken()` (port of legacy `legacy/src/client/auth.ts`: read `?token=`, strip from URL via `history.replaceState`, persist to `localStorage["dashboardToken"]`); `authHeaders()` for fetch; a Pinia `configStore` with `load()` and live `settings:updated` refresh.

- [ ] **Step 1: Scaffold**

```bash
cd src && bun create vite Client --template vue-ts
cd Client && bun install && bun add pinia vue-router @microsoft/signalr
bun add -d vitest @vue/test-utils happy-dom
```
`vite.config.ts`: `build.outDir: '../Narya.Api/wwwroot'`, `emptyOutDir: true`, dev `server.proxy` for `/api` and `/hubs` → `http://localhost:5000` (ws: true for hubs). Add `src/Narya.Api/wwwroot/` to `.gitignore`.

- [ ] **Step 2: Failing token-capture test**

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { captureDashboardToken, getDashboardToken } from '../services/auth'

describe('captureDashboardToken', () => {
  beforeEach(() => localStorage.clear())

  it('stores the token from the query string and strips it from the URL', () => {
    history.replaceState(null, '', '/?token=abc123')
    captureDashboardToken()
    expect(getDashboardToken()).toBe('abc123')
    expect(location.search).not.toContain('abc123')
  })

  it('keeps a previously stored token when the URL has none', () => {
    localStorage.setItem('dashboardToken', 'kept')
    history.replaceState(null, '', '/')
    captureDashboardToken()
    expect(getDashboardToken()).toBe('kept')
  })
})
```

- [ ] **Step 3: Run `bun run vitest run` → FAIL; implement `services/auth.ts`** (mirror legacy semantics: capture before app mount, `Authorization: Bearer` header helper, `?access_token=` for SignalR). Implement `api.ts` (thin fetch wrapper attaching headers, throwing on `INVALID_DASHBOARD_TOKEN` with stored-token discard), `realtime.ts` (HubConnection singleton, `on('event', ...)` dispatch by event name), `configStore.ts`, `HealthView.vue` (shows health JSON + masked config + live-updates on `settings:updated`).

- [ ] **Step 4: Verify end-to-end**

```bash
bun run vitest run          # PASS
bun run build               # emits into ../Narya.Api/wwwroot
dotnet run --project ../Narya.Api   # with Narya__DashboardToken=dev-token
```
Browse `http://localhost:5000/?token=dev-token`: health view renders, token stripped from URL. PUT a config change via curl; the page updates without reload (SignalR).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: Vue 3 client scaffold with token auth and live config view"
```

---

### Task 12: CI workflow

**Files:**
- Create: `.github/workflows/build-test.yml`

**Interfaces:**
- Consumes: everything; runs on PRs to main.

- [ ] **Step 1: Write workflow** — jobs: `dotnet` (setup-dotnet 10.x → `dotnet restore` → `dotnet build --no-restore` → `dotnet test --no-build`; ubuntu runner has Docker for Testcontainers) and `client` (setup-bun → `bun install` → `bun run vitest run` → `bun run build`, working-directory `src/Client`). Keep the legacy app **out** of CI (it has its own local verification and is frozen).

- [ ] **Step 2: Verify + commit** — push branch, confirm both jobs green on GitHub.

```bash
git add -A && git commit -m "chore: add CI workflow for dotnet and Vue client"
```

---

## Self-Review (performed at write time)

- **Spec coverage:** Phase 1 scope from the roadmap — legacy move ✓ (T1), scaffold+CPM ✓ (T2), compose ✓ (T3), Testcontainers ✓ (T4), MediatR+behaviors ✓ (T5), event auto-registration ✓ (T6), AppConfig slice ✓ (T7–T8), auth middleware + health + overlay token ✓ (T9), config endpoints + Redis→SignalR bridge with operator/overlay groups ✓ (T10), Vue scaffold ✓ (T11), CI ✓ (T12).
- **Known execution-time verification points (deliberate, not placeholders):** exact Marten 8.18 API names (`AllKnownEventTypes` vs `EventGraph.AllEvents`, `SnapshotLifecycle` namespace), FluentResults parameterless-ctor behavior (tested in T5), legacy overlay-token derivation byte-parity (tested against legacy in T9), full AppConfig field list diffed against `legacy/src/server/appConfig.ts` (T7).
- **Type consistency:** `AppConfigPatch` defined in Narya.Core (T7), consumed by T8 command and T10 PUT body; `IRealtimeNotification` defined in T8, consumed by T10 bridge; `PostgresFixture.CreateStore` (T4) consumed by T7 via `NaryaMartenConfig.Configure`; `OverlayToken.Derive` (T9) consumed by T9 tests and the overlay-token endpoint. Consistent.
