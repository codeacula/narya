using System.Text.Json;
using System.Text.Json.Serialization;

using Marten;

using Microsoft.AspNetCore.HttpOverrides;

using Narya.Api.Auth;
using Narya.Api.Automation;
using Narya.Api.Dashboard;
using Narya.Api.Realtime;
using Narya.Application;
using Narya.Application.Actions;
using Narya.Application.Automation;
using Narya.Cache;
using Narya.Database;
using Narya.Database.Automation;
using Narya.Twitch;

var builder = WebApplication.CreateBuilder(args);

builder.Services.Configure<NaryaAuthOptions>(builder.Configuration.GetSection("Narya"));
builder.Services.AddSingleton<DashboardTokenAuthenticator>();

// Narya is hosted behind a same-host reverse proxy, so DashboardTokenMiddleware's loopback
// decision would otherwise be made against the proxy's loopback peer address for every request
// on the internet. Narya:TrustedProxies is the explicit allowlist that makes RemoteIpAddress the
// real client instead. It defaults to EMPTY and empty means TRUST NO PROXY — which, per
// TrustedProxies' doc comment, has to be expressed by leaving the middleware uninstalled rather
// than by configuring it with empty Known* lists (ASP.NET reads those as "trust everyone").
var trustedProxies = TrustedProxies.Read(builder.Configuration);
if (trustedProxies.Length > 0)
{
  _ = builder.Services.Configure<ForwardedHeadersOptions>(
    options => TrustedProxies.Configure(options, trustedProxies));
}

// Refuses to start an unsafe no-token deployment. Registered as an IStartupFilter, not run after
// app.StartAsync(), so the check happens while the pipeline is being built and the listening
// socket is still closed — see StartupBindingGuardFilter's doc comment. Skipped under
// SkipInfrastructure, where WebApplicationFactory binds an ephemeral test server with no token by
// design; the guard itself is covered directly by StartupBindingGuardTests.
if (!builder.Configuration.GetValue<bool>("Narya:SkipInfrastructure"))
{
  _ = builder.Services.AddSingleton<IStartupFilter, StartupBindingGuardFilter>();
}

// Registered unconditionally (not inside the SkipInfrastructure guard below): RealtimeHub
// depends on it regardless of which mode is active, and it holds no infrastructure connection
// of its own — just an in-memory connection-id set (see RealtimeConnectionTracker's doc
// comment). A SkipInfrastructure test never calls AddSignalR, so the hub itself is simply never
// mapped/instantiated in that mode; registering the tracker either way is harmless.
builder.Services.AddSingleton<RealtimeConnectionTracker>();

// Narya.Core.Media.MediaKind/MediaSourceType (Phase 4 Task 1) are the first enums the API
// surfaces — without this, System.Text.Json's default enum handling would serialize them as
// integers, silently breaking every consumer that expects legacy's lowercase string literals
// ("audio"/"video", "local"/"remote"). CamelCase turns each single-word member name lowercase
// on both read (request-body binding) and write (response serialization).
builder.Services.AddControllers()
  .AddJsonOptions(options => options.JsonSerializerOptions.Converters.Add(
    new JsonStringEnumConverter(JsonNamingPolicy.CamelCase)));

builder.Services.AddNaryaApplication();

// WebApplicationFactory-based tests set Narya:SkipInfrastructure=true so they can
// exercise the auth middleware and controllers without a live Postgres/Redis. The hub
// and its Redis-backed broadcast service are infrastructure too — those tests substitute
// IMediator/IAppConfigStore directly and must not need a live Redis to start up.
if (!builder.Configuration.GetValue<bool>("Narya:SkipInfrastructure"))
{
  var connectionString = builder.Configuration.GetConnectionString("Narya")
    ?? throw new InvalidOperationException("Missing ConnectionStrings:Narya configuration.");
  _ = builder.Services.AddNaryaDatabase(connectionString);

  // Phase 4 Task 4: replaces AddNaryaApplication's IMediaMuteGate no-op default
  // (NoopMediaMuteGate, TryAddSingleton'd — never muted) with the real
  // IMediaMuteStore-backed adapter, now that AddNaryaDatabase above has registered the real
  // store. A plain AddSingleton always wins the last-registration-wins rule over that earlier
  // TryAddSingleton default (see IActionStepPorts.cs's and MediaMuteGate's doc comments). Kept
  // inside this SkipInfrastructure guard, same reasoning as every other real-store override on
  // this page: MediaMuteGate's IMediaMuteStore dependency only resolves once Marten is
  // composed, so a WebApplicationFactory test under SkipInfrastructure must keep the no-op
  // default (or substitute IMediaMuteGate/IMediaMuteStore directly) rather than register this.
  _ = builder.Services.AddSingleton<IMediaMuteGate, MediaMuteGate>();

  var redisConnectionString = builder.Configuration.GetConnectionString("Redis")
    ?? throw new InvalidOperationException("Missing ConnectionStrings:Redis configuration.");
  _ = builder.Services.AddNaryaCache(redisConnectionString);

  // Twitch registers ITwitchTokenStore and contributes its event types +
  // DbTwitchToken snapshot to the same Marten store via services.ConfigureMarten,
  // so it must be inside the infrastructure guard alongside AddNaryaDatabase.
  _ = builder.Services.AddNaryaTwitch();

  // The live EventSub websocket + its hosted service are a separate opt-in from
  // AddNaryaTwitch (see that method's and AddNaryaTwitchEventSub's doc comments) — kept
  // inside this same guard so a WebApplicationFactory test (SkipInfrastructure=true) never
  // opens a real socket to Twitch.
  _ = builder.Services.AddNaryaTwitchEventSub();

  _ = builder.Services.AddSignalR();
  _ = builder.Services.AddHostedService<RealtimeBroadcastService>();

  // Phase 3 Task 7: needs a live SignalR hub to skip against (RealtimeConnectionTracker is only
  // ever populated by a real RealtimeHub connection) and a live Marten/Twitch DI graph to build
  // a snapshot from — kept inside this same guard so a WebApplicationFactory test never starts
  // the heartbeat loop, the same way it never opens a live Redis subscription.
  _ = builder.Services.AddHostedService<DashboardHeartbeatService>();

  // Phase 4 Task 6: needs a live IAutomationRunStore from a real Marten composition — kept inside
  // this same guard so a WebApplicationFactory test (SkipInfrastructure=true) never starts the
  // prune loop, the same way it never starts the dashboard heartbeat.
  _ = builder.Services.AddHostedService<AutomationRunPruneService>();
}

var app = builder.Build();

// MUST be the first middleware: everything downstream that reads RemoteIpAddress — above all
// DashboardTokenMiddleware's loopback fallback — has to see the real client, not the proxy.
// Installed only when an allowlist exists; with none, an X-Forwarded-For header is never
// consulted at all and the peer address stands as-is.
if (trustedProxies.Length > 0)
{
  _ = app.UseForwardedHeaders();
}

// Static SPA assets (wwwroot) are never gated by the dashboard token — only
// /api is, mirroring legacy's `app.use('/api', requireDashboardToken)`. wwwroot
// may not exist yet at this phase; UseStaticFiles is a no-op file-not-found in
// that case rather than throwing.
app.UseDefaultFiles();
app.UseStaticFiles();

app.UseWhen(
  context => context.Request.Path.StartsWithSegments("/api"),
  apiApp => apiApp.UseMiddleware<DashboardTokenMiddleware>());

app.MapControllers();

// Mirrors the AddSignalR/AddHostedService guard above: under SkipInfrastructure there is
// no live Redis for RealtimeBroadcastService to subscribe through, and AddSignalR was
// never called, so mapping the hub here would fail to resolve its services.
if (!builder.Configuration.GetValue<bool>("Narya:SkipInfrastructure"))
{
  _ = app.MapHub<RealtimeHub>("/hubs/realtime");

  // Phase 4 Task 5: seeds the four built-in dashboard slash commands (Shoutout/Whisper/Timeout/
  // Ban) once, ever — idempotent via BuiltInSlashCommandSeeder's own ledger row, so an operator's
  // later edit or delete of a seeded row is never recreated on the next boot. Needs a live
  // IDocumentStore from AddNaryaDatabase above, so it stays inside this same guard — a
  // WebApplicationFactory test (SkipInfrastructure=true) never runs it.
  await using var seedScope = app.Services.CreateAsyncScope();
  var seedDocumentStore = seedScope.ServiceProvider.GetRequiredService<IDocumentStore>();
  var seedTimeProvider = seedScope.ServiceProvider.GetRequiredService<TimeProvider>();
  await BuiltInSlashCommandSeeder.SeedAsync(seedDocumentStore, seedTimeProvider, CancellationToken.None).ConfigureAwait(false);
}

// SPA fallback: anything not matched by a controller or a static file serves
// index.html, EXCEPT /api (should 404, not silently return HTML — a caller
// that hit this point missed every controller route) and /hubs (the SignalR hub
// mapped above must not be swallowed by the SPA fallback either).
app.MapFallback(async context =>
{
  if (context.Request.Path.StartsWithSegments("/api") || context.Request.Path.StartsWithSegments("/hubs"))
  {
    context.Response.StatusCode = StatusCodes.Status404NotFound;
    return;
  }

  var indexPath = Path.Combine(app.Environment.ContentRootPath, "wwwroot", "index.html");
  if (!File.Exists(indexPath))
  {
    context.Response.StatusCode = StatusCodes.Status404NotFound;
    return;
  }

  context.Response.ContentType = "text/html";
  await context.Response.SendFileAsync(indexPath).ConfigureAwait(false);
});

// StartupBindingGuardFilter (registered above) throws from inside the pipeline build that
// app.Run() triggers, before Kestrel binds — so an unsafe deployment never listens at all.
await app.RunAsync().ConfigureAwait(false);
