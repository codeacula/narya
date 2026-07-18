using System.Net;
using System.Net.Http.Headers;

using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;

using Narya.Core.Actions;
using Narya.Core.AppConfig;
using Narya.Core.Automation;
using Narya.Core.Automod;
using Narya.Core.Chat;
using Narya.Core.Events;
using Narya.Core.Media;
using Narya.Core.Sessions;
using Narya.Core.Viewers;
using Narya.Twitch.Helix;

using NSubstitute;

namespace Narya.Api.Tests.Auth;

public sealed class DashboardTokenMiddlewareTests
{
  /// <summary>
  /// TEST-ONLY header. Production code must never trust a client-supplied
  /// header for <c>HttpContext.Connection.RemoteIpAddress</c> — this only has
  /// any effect when <see cref="TestRemoteIpStartupFilter"/> is registered,
  /// which <see cref="BuildClient"/> only does when explicitly asked.
  /// </summary>
  private const string TestRemoteIpHeader = "X-Test-Remote-Ip";

  private static HttpClient BuildClient(string configuredToken, bool injectRemoteIp = false) =>
    new WebApplicationFactory<Program>()
      .WithWebHostBuilder(b =>
      {
        // UseSetting (not ConfigureAppConfiguration+AddInMemoryCollection) — Program.cs
        // reads Narya:SkipInfrastructure in top-level code via
        // builder.Configuration.GetValue<bool>(...), which runs BEFORE
        // WebApplicationFactory applies ConfigureAppConfiguration sources. UseSetting is
        // visible at that read; AddInMemoryCollection is not, so the guard silently never
        // engaged and these tests exercised a live Marten/Redis connection.
        _ = b.UseSetting("Narya:DashboardToken", configuredToken);
        _ = b.UseSetting("Narya:SkipInfrastructure", "true"); // Program.cs guard: no Marten/Redis in these tests

        // Under SkipInfrastructure, AddNaryaDatabase (the only source of IAppConfigStore,
        // IStreamSessionStore, IChatStore, and IStreamEventStore) never runs. Nothing in this
        // class exercises /api/config, stream sessions, chat, or stream events, but the host
        // still has to build: ASP.NET's default Development-environment DI validation
        // (ValidateOnBuild) eagerly constructs every registered handler, including the
        // /api/config MediatR handlers that take a constructor dependency on IAppConfigStore,
        // the Sessions StreamOnlineHandler/StreamOfflineHandler that depend on
        // IStreamSessionStore, the chat PersistChatMessageHandler/GetRecentChatMessagesQueryHandler/
        // GetRecentChatEventsQueryHandler that depend on IChatStore, and the Events
        // PersistStreamEventHandler/UpdateStreamEventHandler/GetRecentStreamEventsQueryHandler
        // that depend on IStreamEventStore, the Viewers UpdateViewerProfileCommandHandler/
        // GetRosterQueryHandler/GetRecentViewersQueryHandler that depend on IViewerStore, and
        // the Automod RecordAutomodHoldHandler/ResolveAutomodHoldHandler/GetAutomodQueueQueryHandler
        // that depend on IAutomodStore, and (Phase 4 Task 1/2) MediaAssetsController/ActionsController
        // themselves, which depend on IMediaAssetStore/IActionStore directly. Unconfigured
        // substitutes are enough to satisfy that — their methods are never invoked by any test in
        // this class. Phase 4 Task 3: ActionExecutor (a real, unguarded AddSingleton) hard-depends
        // on IMediaResolver/IHelixClient, neither of which has an infrastructure-free default —
        // both need an unconfigured substitute here too.
        _ = b.ConfigureTestServices(services =>
        {
          _ = services.AddSingleton(Substitute.For<IAppConfigStore>());
          _ = services.AddSingleton(Substitute.For<IStreamSessionStore>());
          _ = services.AddSingleton(Substitute.For<IChatStore>());
          _ = services.AddSingleton(Substitute.For<IStreamEventStore>());
          _ = services.AddSingleton(Substitute.For<IViewerStore>());
          _ = services.AddSingleton(Substitute.For<IAutomodStore>());
          _ = services.AddSingleton(Substitute.For<IMediaAssetStore>());
          _ = services.AddSingleton(Substitute.For<IActionStore>());
          _ = services.AddSingleton(Substitute.For<IMediaResolver>());
          _ = services.AddSingleton(Substitute.For<IHelixClient>());
          _ = services.AddSingleton(Substitute.For<IMediaMuteStore>());
        });

        if (injectRemoteIp)
        {
          _ = b.ConfigureTestServices(services =>
            services.AddSingleton<IStartupFilter, TestRemoteIpStartupFilter>());
        }
      })
      .CreateClient();

  /// <summary>
  /// Sets <c>HttpContext.Connection.RemoteIpAddress</c> from the TEST-ONLY
  /// <see cref="TestRemoteIpHeader"/> header, ahead of the real pipeline
  /// (<c>Configure</c> only runs the delegate we add here, then calls
  /// <paramref name="next"/> for Program.cs's own middleware, so this always
  /// executes before <c>DashboardTokenMiddleware</c>).
  ///
  /// Exists because <c>WebApplicationFactory</c>'s in-process <c>TestServer</c>
  /// always presents a null <c>RemoteIpAddress</c> — that's a real code path
  /// worth its own test (see <c>NoTokenConfiguredNullRemoteIpIsForbidden</c>),
  /// but on its own it can't prove the loopback and non-loopback branches of
  /// <c>DashboardTokenMiddleware.IsLoopback</c>, which is exactly the security
  /// property under test here.
  /// </summary>
  private sealed class TestRemoteIpStartupFilter : IStartupFilter
  {
    public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next) => app =>
    {
      _ = app.Use(async (context, nextMiddleware) =>
      {
        var header = context.Request.Headers[TestRemoteIpHeader].ToString();
        if (!string.IsNullOrEmpty(header) && IPAddress.TryParse(header, out var ip))
        {
          context.Connection.RemoteIpAddress = ip;
        }

        await nextMiddleware().ConfigureAwait(false);
      });

      next(app);
    };
  }

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
  public async Task OperatorXDashboardTokenHeaderPasses()
  {
    var client = BuildClient("op-token");
    client.DefaultRequestHeaders.Add("X-Dashboard-Token", "op-token");
    var response = await client.GetAsync("/api/health");
    Assert.Equal(HttpStatusCode.OK, response.StatusCode);
  }

  [Fact]
  public async Task WrongTokenIs401WithCode()
  {
    var client = BuildClient("op-token");
    client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", "not-the-token");
    var response = await client.GetAsync("/api/health");
    Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    Assert.Contains("INVALID_DASHBOARD_TOKEN", await response.Content.ReadAsStringAsync());
  }

  [Fact]
  public async Task OverlayTokenReachesAllowlistedGetOnly()
  {
    var overlay = Narya.Api.Auth.OverlayToken.Derive("op-token");
    var client = BuildClient("op-token");
    var ok = await client.GetAsync($"/api/health?token={overlay}");
    Assert.Equal(HttpStatusCode.OK, ok.StatusCode);

    // /api/config isn't guaranteed to exist yet under SkipInfrastructure (Task 10
    // ships it) — the point being proven is that the middleware itself rejects an
    // overlay token on a non-allowlisted path before any endpoint runs, so a
    // non-existent-but-non-allowlisted route works just as well as a real one.
    var forbidden = await client.GetAsync($"/api/config?token={overlay}");
    Assert.Equal(HttpStatusCode.Forbidden, forbidden.StatusCode);
  }

  [Fact]
  public async Task OverlayTokenRejectedOnOverlayTokenEndpoint()
  {
    var overlay = Narya.Api.Auth.OverlayToken.Derive("op-token");
    var client = BuildClient("op-token");
    var response = await client.GetAsync($"/api/auth/overlay-token?token={overlay}");
    Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
  }

  [Fact]
  public async Task OperatorCanFetchOverlayTokenEndpoint()
  {
    var client = BuildClient("op-token");
    client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", "op-token");
    var response = await client.GetAsync("/api/auth/overlay-token");
    Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    var body = await response.Content.ReadAsStringAsync();
    Assert.Contains(Narya.Api.Auth.OverlayToken.Derive("op-token"), body);
  }

  [Fact]
  public async Task NoTokenConfiguredOverlayTokenEndpointIs404()
  {
    // Prior to the fail-closed fix, this test passed only because
    // WebApplicationFactory's TestServer presents a null RemoteIpAddress,
    // which the middleware used to (incorrectly) treat as loopback. It's now
    // an explicit loopback caller so it keeps testing what it says it tests —
    // an operator with no token configured hitting the overlay-token
    // endpoint — rather than depending on the fail-open bug fixed below.
    var client = BuildClient(string.Empty, injectRemoteIp: true);
    client.DefaultRequestHeaders.Add(TestRemoteIpHeader, "127.0.0.1");
    var response = await client.GetAsync("/api/auth/overlay-token");
    Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
  }

  [Fact]
  public async Task NoTokenConfiguredLoopbackCallerIsOperator()
  {
    var client = BuildClient(string.Empty, injectRemoteIp: true);
    client.DefaultRequestHeaders.Add(TestRemoteIpHeader, "127.0.0.1");
    var response = await client.GetAsync("/api/health");
    Assert.Equal(HttpStatusCode.OK, response.StatusCode);
  }

  [Fact]
  public async Task NoTokenConfiguredNonLoopbackCallerIsForbidden()
  {
    var client = BuildClient(string.Empty, injectRemoteIp: true);
    client.DefaultRequestHeaders.Add(TestRemoteIpHeader, "203.0.113.5");
    var response = await client.GetAsync("/api/health");
    Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
  }

  [Fact]
  public async Task NoTokenConfiguredNullRemoteIpIsForbidden()
  {
    // No X-Test-Remote-Ip injected at all — TestServer's RemoteIpAddress is
    // null here, exactly as it would be for Kestrel over a Unix domain
    // socket. This is the direct regression test for the fail-open bug: null
    // must not be treated as loopback.
    var client = BuildClient(string.Empty);
    var response = await client.GetAsync("/api/health");
    Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
  }
}
