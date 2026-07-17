using Narya.Api.Auth;
using Narya.Application;
using Narya.Database;

var builder = WebApplication.CreateBuilder(args);

builder.Services.Configure<NaryaAuthOptions>(builder.Configuration.GetSection("Narya"));
builder.Services.AddControllers();

builder.Services.AddNaryaApplication();

// WebApplicationFactory-based tests set Narya:SkipInfrastructure=true so they can
// exercise the auth middleware and controllers without a live Postgres/Redis.
if (!builder.Configuration.GetValue<bool>("Narya:SkipInfrastructure"))
{
  var connectionString = builder.Configuration.GetConnectionString("Narya")
    ?? throw new InvalidOperationException("Missing ConnectionStrings:Narya configuration.");
  _ = builder.Services.AddNaryaDatabase(connectionString);

  // Redis cache registration (AddNaryaCache) lands in Task 10 alongside SignalR.
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

// SPA fallback: anything not matched by a controller or a static file serves
// index.html, EXCEPT /api (should 404, not silently return HTML — a caller
// that hit this point missed every controller route) and /hubs (SignalR lands
// here in a later phase and must not be swallowed by the SPA fallback either).
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
