using System.Net;

using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Connections.Features;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Options;

using Narya.Api.Auth;
using Narya.Api.Realtime;

using NSubstitute;

namespace Narya.Api.Tests.Realtime;

/// <summary>
/// The hub must reach the SAME loopback decision as <see cref="DashboardTokenMiddleware"/> when
/// no dashboard token is configured. Before this parity existed, a local no-token dashboard could
/// load REST data but every SignalR connection was aborted, so it never received a realtime
/// update or a heartbeat.
/// </summary>
public sealed class RealtimeHubAuthTests
{
  private const string ConnectionId = "conn-1";

  /// <summary>
  /// What <c>Context.GetHttpContext()</c> reads. SignalR's real implementation is internal, and
  /// this is the only feature the hub touches.
  /// </summary>
  private sealed class StubHttpContextFeature : IHttpContextFeature
  {
    public HttpContext? HttpContext { get; set; }
  }

  /// <summary>
  /// <paramref name="allowLoopbackOperatorWithoutToken"/> defaults to true because these tests
  /// are about hub/middleware PARITY on the loopback decision, so the opt-in that decision
  /// depends on has to be on for all but the test that covers the opt-in itself.
  /// </summary>
  private static (RealtimeHub Hub, HubCallerContext Context, RealtimeConnectionTracker Tracker) BuildHub(
    string configuredToken,
    IPAddress? remoteIp,
    string? accessToken = null,
    bool allowLoopbackOperatorWithoutToken = true)
  {
    var authenticator = new DashboardTokenAuthenticator(Options.Create(new NaryaAuthOptions
    {
      DashboardToken = configuredToken,
      AllowLoopbackOperatorWithoutToken = allowLoopbackOperatorWithoutToken,
    }));
    var tracker = new RealtimeConnectionTracker();

    var httpContext = new DefaultHttpContext();
    httpContext.Connection.RemoteIpAddress = remoteIp;
    if (accessToken is not null)
    {
      httpContext.Request.QueryString = QueryString.Create("access_token", accessToken);
    }

    var features = new FeatureCollection();
    features.Set<IHttpContextFeature>(new StubHttpContextFeature { HttpContext = httpContext });

    var context = Substitute.For<HubCallerContext>();
    _ = context.ConnectionId.Returns(ConnectionId);
    _ = context.Features.Returns(features);

    var hub = new RealtimeHub(authenticator, tracker)
    {
      Context = context,
      Groups = Substitute.For<IGroupManager>(),
    };

    return (hub, context, tracker);
  }

  [Fact]
  public async Task NoTokenConfiguredLoopbackConnectionGetsTheOperatorRole()
  {
    var (hub, context, tracker) = BuildHub(string.Empty, IPAddress.Loopback);

    await hub.OnConnectedAsync();

    context.DidNotReceive().Abort();
    Assert.Equal(1, tracker.OperatorCount);
    await hub.Groups.Received(1).AddToGroupAsync(ConnectionId, RealtimeHub.OperatorGroup);
  }

  [Fact]
  public async Task NoTokenConfiguredIpv6LoopbackConnectionGetsTheOperatorRole()
  {
    var (hub, context, tracker) = BuildHub(string.Empty, IPAddress.IPv6Loopback);

    await hub.OnConnectedAsync();

    context.DidNotReceive().Abort();
    Assert.Equal(1, tracker.OperatorCount);
  }

  [Fact]
  public async Task NoTokenConfiguredNonLoopbackConnectionIsAborted()
  {
    var (hub, context, tracker) = BuildHub(string.Empty, IPAddress.Parse("203.0.113.5"));

    await hub.OnConnectedAsync();

    context.Received(1).Abort();
    Assert.Equal(0, tracker.Count);
  }

  /// <summary>
  /// Same fail-closed rule as the middleware: an unknown peer address (Kestrel over a Unix
  /// domain socket, for instance) is not loopback.
  /// </summary>
  [Fact]
  public async Task NoTokenConfiguredNullRemoteIpIsAborted()
  {
    var (hub, context, tracker) = BuildHub(string.Empty, remoteIp: null);

    await hub.OnConnectedAsync();

    context.Received(1).Abort();
    Assert.Equal(0, tracker.Count);
  }

  /// <summary>
  /// The loopback fallback applies ONLY when no token is configured. Once one is, a loopback
  /// caller with no (or a wrong) token is just an unauthenticated caller.
  /// </summary>
  [Fact]
  public async Task TokenConfiguredLoopbackConnectionWithoutATokenIsStillAborted()
  {
    var (hub, context, tracker) = BuildHub("op-token", IPAddress.Loopback);

    await hub.OnConnectedAsync();

    context.Received(1).Abort();
    Assert.Equal(0, tracker.Count);
  }

  /// <summary>
  /// Parity with <c>DashboardTokenMiddlewareTests.NoTokenConfiguredLoopbackCallerWithoutTheOptInIsForbidden</c>:
  /// the loopback fallback is an explicit opt-in on both paths, so the shipped default of
  /// configuring nothing aborts the connection rather than granting the operator role.
  /// </summary>
  [Fact]
  public async Task NoTokenConfiguredLoopbackConnectionWithoutTheOptInIsAborted()
  {
    var (hub, context, tracker) = BuildHub(
      string.Empty, IPAddress.Loopback, allowLoopbackOperatorWithoutToken: false);

    await hub.OnConnectedAsync();

    context.Received(1).Abort();
    Assert.Equal(0, tracker.Count);
  }

  [Fact]
  public async Task TokenConfiguredOperatorTokenStillConnects()
  {
    var (hub, context, tracker) = BuildHub("op-token", IPAddress.Parse("203.0.113.5"), accessToken: "op-token");

    await hub.OnConnectedAsync();

    context.DidNotReceive().Abort();
    Assert.Equal(1, tracker.OperatorCount);
  }
}
