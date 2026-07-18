using System.Net;
using System.Net.Http.Headers;

using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;

using Narya.Api.Auth;
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

  /// <summary>
  /// Defaults to FALSE, matching the shipped <c>appsettings.json</c>: the no-token loopback
  /// operator path is an explicit opt-in, so a test that wants it must say so. See
  /// <see cref="NoTokenConfiguredLoopbackCallerWithoutTheOptInIsForbidden"/>.
  /// </summary>
  private static HttpClient BuildClient(
    string configuredToken,
    bool injectRemoteIp = false,
    bool allowLoopbackOperatorWithoutToken = false,
    params string[] trustedProxies) =>
    new WebApplicationFactory<Program>()
      .WithWebHostBuilder(b =>
      {
        // Program.cs reads Narya:TrustedProxies as an array; UseSetting writes the indexed
        // child keys the array binder consumes. Passing none leaves the allowlist empty, which
        // is the production default and the fail-closed case.
        for (var i = 0; i < trustedProxies.Length; i++)
        {
          _ = b.UseSetting($"{TrustedProxies.ConfigKey}:{i}", trustedProxies[i]);
        }

        // UseSetting (not ConfigureAppConfiguration+AddInMemoryCollection) — Program.cs
        // reads Narya:SkipInfrastructure in top-level code via
        // builder.Configuration.GetValue<bool>(...), which runs BEFORE
        // WebApplicationFactory applies ConfigureAppConfiguration sources. UseSetting is
        // visible at that read; AddInMemoryCollection is not, so the guard silently never
        // engaged and these tests exercised a live Marten/Redis connection.
        _ = b.UseSetting("Narya:DashboardToken", configuredToken);
        _ = b.UseSetting(
          StartupBindingGuard.AllowLoopbackOperatorWithoutTokenConfigKey,
          allowLoopbackOperatorWithoutToken ? "true" : "false");
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
          _ = services.AddSingleton(Substitute.For<IAutomationTriggerStore>());
          _ = services.AddSingleton(Substitute.For<IAutomationRunStore>());
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
    var client = BuildClient(string.Empty, injectRemoteIp: true, allowLoopbackOperatorWithoutToken: true);
    client.DefaultRequestHeaders.Add(TestRemoteIpHeader, "127.0.0.1");
    var response = await client.GetAsync("/api/auth/overlay-token");
    Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
  }

  [Fact]
  public async Task NoTokenConfiguredLoopbackCallerIsOperator()
  {
    var client = BuildClient(string.Empty, injectRemoteIp: true, allowLoopbackOperatorWithoutToken: true);
    client.DefaultRequestHeaders.Add(TestRemoteIpHeader, "127.0.0.1");
    var response = await client.GetAsync("/api/health");
    Assert.Equal(HttpStatusCode.OK, response.StatusCode);
  }

  /// <summary>
  /// The shipped default. Without the explicit opt-in the loopback fallback does not exist at
  /// all, so even a genuine local caller is refused — the request-time half of making
  /// "operator configured nothing" fail closed. In a real host
  /// <see cref="StartupBindingGuard"/> refuses to start this configuration outright
  /// (<c>StartupBindingGuardTests.LoopbackBindingWithNoTokenAndNoOptInThrows</c>); this asserts
  /// the middleware does not grant operator access even if it is somehow reached.
  /// </summary>
  [Fact]
  public async Task NoTokenConfiguredLoopbackCallerWithoutTheOptInIsForbidden()
  {
    var client = BuildClient(string.Empty, injectRemoteIp: true);
    client.DefaultRequestHeaders.Add(TestRemoteIpHeader, "127.0.0.1");

    var response = await client.GetAsync("/api/health");

    Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
  }

  [Fact]
  public async Task NoTokenConfiguredNonLoopbackCallerIsForbidden()
  {
    var client = BuildClient(string.Empty, injectRemoteIp: true, allowLoopbackOperatorWithoutToken: true);
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
    var client = BuildClient(string.Empty, allowLoopbackOperatorWithoutToken: true);
    var response = await client.GetAsync("/api/health");
    Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
  }

  /// <summary>
  /// Fails closed with an unconfigured allowlist: the peer is not a trusted proxy, so its
  /// <c>X-Forwarded-For</c> claim of being loopback must be ignored and the real (non-loopback)
  /// peer address must be what the middleware judges.
  /// </summary>
  [Fact]
  public async Task UntrustedPeerCannotSpoofLoopbackViaForwardedFor()
  {
    var client = BuildClient(string.Empty, injectRemoteIp: true, allowLoopbackOperatorWithoutToken: true);
    client.DefaultRequestHeaders.Add(TestRemoteIpHeader, "203.0.113.5");
    client.DefaultRequestHeaders.Add("X-Forwarded-For", "127.0.0.1");

    var response = await client.GetAsync("/api/health");

    Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
  }

  /// <summary>
  /// With the same-host proxy allowlisted, a request it forwards is judged against the REAL
  /// client address — so an internet client reaching a no-token deployment through the proxy is
  /// rejected, even though the proxy's own peer address is loopback.
  ///
  /// <para>
  /// This combination (a declared proxy and no token) can no longer start a real host at all:
  /// <c>StartupBindingGuardTests.LoopbackBindingBehindADeclaredProxyWithNoTokenThrows</c> is the
  /// primary defence. These tests run under <c>SkipInfrastructure</c>, where the guard is not
  /// registered, and pin the request-time behaviour behind it.
  /// </para>
  /// </summary>
  [Fact]
  public async Task ForwardedNonLoopbackClientThroughATrustedProxyIsForbidden()
  {
    var client = BuildClient(
      string.Empty, injectRemoteIp: true, allowLoopbackOperatorWithoutToken: true, trustedProxies: "127.0.0.1");
    client.DefaultRequestHeaders.Add(TestRemoteIpHeader, "127.0.0.1");
    client.DefaultRequestHeaders.Add("X-Forwarded-For", "198.51.100.7");

    var response = await client.GetAsync("/api/health");

    Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
  }

  /// <summary>
  /// The positive control for the test above — without it, that test would pass even if
  /// <c>UseForwardedHeaders</c> were never wired up at all. A genuinely local client relayed by
  /// the allowlisted proxy still resolves to loopback, hence operator.
  /// </summary>
  [Fact]
  public async Task ForwardedLoopbackClientThroughATrustedProxyIsOperator()
  {
    var client = BuildClient(
      string.Empty, injectRemoteIp: true, allowLoopbackOperatorWithoutToken: true, trustedProxies: "127.0.0.1");
    client.DefaultRequestHeaders.Add(TestRemoteIpHeader, "127.0.0.1");
    client.DefaultRequestHeaders.Add("X-Forwarded-For", "127.0.0.1");

    var response = await client.GetAsync("/api/health");

    Assert.Equal(HttpStatusCode.OK, response.StatusCode);
  }

  /// <summary>
  /// Pins the hazard that motivated requiring a token whenever a proxy is declared:
  /// <c>ForwardedHeadersMiddleware</c> leaves <c>RemoteIpAddress</c> ALONE when
  /// <c>X-Forwarded-For</c> is absent, and nginx omits that header unless
  /// <c>proxy_set_header X-Forwarded-For</c> is configured — the omission is the nginx default,
  /// not an exotic mistake. So the peer address falls through to the proxy's own loopback
  /// address and, at this layer, still resolves to the operator role. That is why this
  /// configuration must never be startable, which
  /// <c>StartupBindingGuardTests.LoopbackBindingBehindADeclaredProxyWithNoTokenThrows</c>
  /// enforces. If this assertion ever has to change, the guard is what to check first.
  /// </summary>
  [Fact]
  public async Task TrustedProxyPeerWithNoForwardedForHeaderFallsBackToThePeerAddress()
  {
    var client = BuildClient(
      string.Empty, injectRemoteIp: true, allowLoopbackOperatorWithoutToken: true, trustedProxies: "127.0.0.1");
    client.DefaultRequestHeaders.Add(TestRemoteIpHeader, "127.0.0.1");

    var response = await client.GetAsync("/api/health");

    Assert.Equal(HttpStatusCode.OK, response.StatusCode);
  }

  /// <summary>A CIDR entry in the allowlist is honoured the same way a bare address is.</summary>
  [Fact]
  public async Task TrustedProxyCidrRangeIsHonoured()
  {
    var client = BuildClient(
      string.Empty, injectRemoteIp: true, allowLoopbackOperatorWithoutToken: true, trustedProxies: "10.0.0.0/8");
    client.DefaultRequestHeaders.Add(TestRemoteIpHeader, "10.1.2.3");
    client.DefaultRequestHeaders.Add("X-Forwarded-For", "127.0.0.1");

    var response = await client.GetAsync("/api/health");

    Assert.Equal(HttpStatusCode.OK, response.StatusCode);
  }
}
