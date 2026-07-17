using Narya.Api.Auth;
using Narya.Api.Realtime;
using Narya.Application;
using Narya.Cache;
using Narya.Database;
using Narya.Twitch;

var builder = WebApplication.CreateBuilder(args);

builder.Services.Configure<NaryaAuthOptions>(builder.Configuration.GetSection("Narya"));
builder.Services.AddSingleton<DashboardTokenAuthenticator>();
builder.Services.AddControllers();

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
}

var app = builder.Build();

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

app.Run();
