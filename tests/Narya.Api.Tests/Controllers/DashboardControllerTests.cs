using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;

using FluentResults;

using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;

using NSubstitute;

using Narya.Api.Auth;
using Narya.Core.Actions;
using Narya.Core.AppConfig;
using Narya.Core.Automod;
using Narya.Core.Chat;
using Narya.Core.Events;
using Narya.Core.Media;
using Narya.Core.Sessions;
using Narya.Core.Viewers;

using DomainConfig = Narya.Domain.AppConfig.AppConfig;

namespace Narya.Api.Tests.Controllers;

/// <summary>
/// Exercises <c>/api/dashboard/events</c>, <c>/api/dashboard/viewers</c>,
/// <c>/api/dashboard/viewers/{login}/profile</c>, <c>/api/dashboard/session-shoutouts</c>, and
/// <c>/api/dashboard/status</c> through the real MediatR pipeline — only
/// <see cref="IStreamEventStore"/>/<see cref="IViewerStore"/>/<see cref="IStreamSessionStore"/>
/// are substituted with controlled instances (via <c>ConfigureTestServices</c>), since
/// <c>AddNaryaDatabase</c> is skipped under <c>Narya:SkipInfrastructure=true</c>.
/// <see cref="IAppConfigStore"/> is substituted with a valid empty config (see
/// <see cref="BuildDefaultAppConfigStore"/> — <c>GetDashboardStatusQueryHandler</c> calls it
/// unconditionally, unlike every other handler this controller exercises).
/// <see cref="IChatStore"/> is substituted unconfigured (nothing here exercises the specific
/// counts it returns beyond NSubstitute's own <c>Task&lt;int&gt;</c> zero default), same reason
/// as <c>ConfigControllerTests</c>. <c>GET /api/dashboard/session-shoutouts</c> is the one
/// overlay-allowlisted route in this controller — every other route (including the new
/// <c>GET /api/dashboard/status</c>) asserts 403 with an overlay token, mirroring
/// <c>ChatControllerTests.GetRecentEventsIsForbiddenWithAnOverlayToken</c>.
/// </summary>
public sealed class DashboardControllerTests
{
  private const string OperatorToken = "op-token";

  private static HttpClient BuildOperatorClient(IStreamEventStore store) =>
    BuildOperatorClient(store, Substitute.For<IViewerStore>());

  private static HttpClient BuildOperatorClient(IViewerStore store) =>
    BuildOperatorClient(Substitute.For<IStreamEventStore>(), store);

  private static HttpClient BuildOperatorClient(IStreamEventStore streamEventStore, IViewerStore viewerStore) =>
    BuildOperatorClient(streamEventStore, viewerStore, Substitute.For<IStreamSessionStore>());

  private static HttpClient BuildOperatorClient(IStreamSessionStore sessionStore) =>
    BuildOperatorClient(Substitute.For<IStreamEventStore>(), Substitute.For<IViewerStore>(), sessionStore);

  private static HttpClient BuildOperatorClient(
    IStreamEventStore streamEventStore, IViewerStore viewerStore, IStreamSessionStore sessionStore)
  {
    var client = new WebApplicationFactory<Program>()
      .WithWebHostBuilder(b =>
      {
        _ = b.UseSetting("Narya:DashboardToken", OperatorToken);
        _ = b.UseSetting("Narya:SkipInfrastructure", "true");

        _ = b.ConfigureTestServices(services =>
        {
          _ = services.AddSingleton(streamEventStore);
          _ = services.AddSingleton(viewerStore);
          _ = services.AddSingleton(BuildDefaultAppConfigStore());
          _ = services.AddSingleton(sessionStore);
          _ = services.AddSingleton(Substitute.For<IChatStore>());
          _ = services.AddSingleton(Substitute.For<IAutomodStore>());
          _ = services.AddSingleton(Substitute.For<IMediaAssetStore>());
          _ = services.AddSingleton(Substitute.For<IActionStore>());
        });
      })
      .CreateClient();

    client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", OperatorToken);
    return client;
  }

  /// <summary>
  /// Unconfigured (<c>Substitute.For&lt;IAppConfigStore&gt;()</c>) returns a null
  /// <c>Result&lt;DomainConfig&gt;</c> from <c>GetAsync</c> — fine for the routes in this
  /// controller that never touch it, but <c>GetDashboardStatusQueryHandler</c> (Phase 3 Task 7)
  /// does, and would NullReferenceException on <c>Result.IsFailed</c>. This gives every
  /// <c>BuildOperatorClient</c> overload a store that behaves like a real, empty config instead.
  /// </summary>
  private static IAppConfigStore BuildDefaultAppConfigStore()
  {
    var store = Substitute.For<IAppConfigStore>();
    _ = store.GetAsync(Arg.Any<CancellationToken>()).Returns(Result.Ok(new DomainConfig()));
    return store;
  }

  [Fact]
  public async Task GetEventsReturnsTheStoresEventsWithAgo()
  {
    var store = Substitute.For<IStreamEventStore>();
    var receivedAt = DateTimeOffset.UtcNow.AddMinutes(-2);
    IReadOnlyList<StreamEvent> events =
    [
      new StreamEvent(
        Id: "event-1", Kind: "follow", Actor: "Viewer", Detail: "followed", Tone: "silver",
        ReceivedAt: receivedAt, SessionId: "session-1"),
    ];
    _ = store.GetRecentAsync(50, Arg.Any<CancellationToken>()).Returns(events);
    var client = BuildOperatorClient(store);

    var response = await client.GetAsync("/api/dashboard/events");

    Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    var body = await response.Content.ReadAsStringAsync();
    Assert.Contains("\"id\":\"event-1\"", body);
    Assert.Contains("\"kind\":\"follow\"", body);
    Assert.Contains("\"sessionId\":\"session-1\"", body);
    // Exact "ago" formatting (e.g. "2:00") is covered deterministically by RelativeTimeTests and
    // GetRecentStreamEventsQueryTests with a fixed clock — asserting an exact value here against
    // the real system clock would be timing-flaky. This only proves the route wires it through.
    Assert.Matches("\"ago\":\"\\d+:\\d\\d\"", body);
  }

  [Fact]
  public async Task GetEventsIsForbiddenWithAnOverlayToken()
  {
    var store = Substitute.For<IStreamEventStore>();
    var client = BuildOperatorClient(store);
    var overlay = OverlayToken.Derive(OperatorToken);

    client.DefaultRequestHeaders.Authorization = null;
    var response = await client.GetAsync($"/api/dashboard/events?token={overlay}");

    Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    _ = await store.DidNotReceive().GetRecentAsync(Arg.Any<int>(), Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task GetViewersReturnsTheStoresRecentViewersProjection()
  {
    var store = Substitute.For<IViewerStore>();
    IReadOnlyDictionary<string, Viewer> viewers = new Dictionary<string, Viewer>
    {
      ["viewer"] = new Viewer(
        Display: "Viewer", Color: "#111111", Roles: ["sub"], Followed: "not available",
        Subbed: "subscriber badge present", AccountAge: "not available", Recent: []),
    };
    _ = store.GetRecentViewersAsync(500, Arg.Any<CancellationToken>()).Returns(viewers);
    var client = BuildOperatorClient(store);

    var response = await client.GetAsync("/api/dashboard/viewers");

    Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    var body = await response.Content.ReadAsStringAsync();
    Assert.Contains("\"viewer\":{", body);
    Assert.Contains("\"display\":\"Viewer\"", body);
    Assert.Contains("\"subbed\":\"subscriber badge present\"", body);
  }

  [Fact]
  public async Task GetViewersIsForbiddenWithAnOverlayToken()
  {
    var store = Substitute.For<IViewerStore>();
    var client = BuildOperatorClient(store);
    var overlay = OverlayToken.Derive(OperatorToken);

    client.DefaultRequestHeaders.Authorization = null;
    var response = await client.GetAsync($"/api/dashboard/viewers?token={overlay}");

    Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    _ = await store.DidNotReceive().GetRecentViewersAsync(Arg.Any<int>(), Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task PatchProfileReturnsTheNormalizedProfile()
  {
    var store = Substitute.For<IViewerStore>();
    _ = store.UpsertProfileAsync(
      "viewer", "Real Name", Arg.Any<IReadOnlyList<string>>(), "a note", Arg.Any<DateTimeOffset>(), Arg.Any<CancellationToken>())
      .Returns(new ViewerProfileUpdate("Real Name", ["fan"], "a note"));
    var client = BuildOperatorClient(store);
    string[] tags = ["fan"];

    var response = await client.PatchAsJsonAsync(
      "/api/dashboard/viewers/viewer/profile",
      new { realName = "Real Name", tags, note = "a note" });

    Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    var body = await response.Content.ReadAsStringAsync();
    Assert.Contains("\"realName\":\"Real Name\"", body);
    Assert.Contains("\"note\":\"a note\"", body);
  }

  [Fact]
  public async Task PatchProfileReturnsBadRequestWhenRealNameExceedsTheLimit()
  {
    var store = Substitute.For<IViewerStore>();
    var client = BuildOperatorClient(store);

    var response = await client.PatchAsJsonAsync(
      "/api/dashboard/viewers/viewer/profile",
      new { realName = new string('x', 121), tags = Array.Empty<string>(), note = "" });

    Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    _ = await store.DidNotReceive().UpsertProfileAsync(
      Arg.Any<string>(), Arg.Any<string>(), Arg.Any<IReadOnlyList<string>>(), Arg.Any<string>(),
      Arg.Any<DateTimeOffset>(), Arg.Any<CancellationToken>());
  }

  /// <summary>
  /// A tags array element that deserializes to a non-string JSON type fails ASP.NET model
  /// binding outright (before <c>UpdateViewerProfileCommandValidator</c> ever runs) — see that
  /// validator's doc comment on its null-tag rule for why only the JSON-`null` case needs an
  /// explicit check. This test locks in the assumption: a JSON number in the tags array must
  /// 400, matching legacy's <c>if (typeof item !== 'string') throw ...</c>.
  /// </summary>
  [Fact]
  public async Task PatchProfileReturnsBadRequestWhenATagIsNotAString()
  {
    var store = Substitute.For<IViewerStore>();
    var client = BuildOperatorClient(store);

    var response = await client.PatchAsync(
      "/api/dashboard/viewers/viewer/profile",
      new StringContent(
        """{"realName":"x","tags":[123],"note":""}""",
        System.Text.Encoding.UTF8,
        "application/json"));

    Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    _ = await store.DidNotReceive().UpsertProfileAsync(
      Arg.Any<string>(), Arg.Any<string>(), Arg.Any<IReadOnlyList<string>>(), Arg.Any<string>(),
      Arg.Any<DateTimeOffset>(), Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task PatchProfileIsForbiddenWithAnOverlayToken()
  {
    var store = Substitute.For<IViewerStore>();
    var client = BuildOperatorClient(store);
    var overlay = OverlayToken.Derive(OperatorToken);

    client.DefaultRequestHeaders.Authorization = null;
    var response = await client.PatchAsJsonAsync(
      $"/api/dashboard/viewers/viewer/profile?token={overlay}",
      new { realName = "x", tags = Array.Empty<string>(), note = "" });

    Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    _ = await store.DidNotReceive().UpsertProfileAsync(
      Arg.Any<string>(), Arg.Any<string>(), Arg.Any<IReadOnlyList<string>>(), Arg.Any<string>(),
      Arg.Any<DateTimeOffset>(), Arg.Any<CancellationToken>());
  }

  /// <summary>
  /// Overlay-allowlisted — see <c>DashboardTokenMiddleware.OverlayPaths</c>. The
  /// <c>/overlay/shoutouts</c> ticker needs this to succeed with an overlay token, unlike every
  /// other route in this controller.
  /// </summary>
  [Fact]
  public async Task GetSessionShoutoutsSucceedsWithAnOverlayToken()
  {
    var sessionStore = Substitute.For<IStreamSessionStore>();
    _ = sessionStore.GetCurrentSessionIdAsync(Arg.Any<CancellationToken>()).Returns((string?)null);
    var client = BuildOperatorClient(sessionStore);
    var overlay = OverlayToken.Derive(OperatorToken);

    client.DefaultRequestHeaders.Authorization = null;
    var response = await client.GetAsync($"/api/dashboard/session-shoutouts?token={overlay}");

    Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    var body = await response.Content.ReadAsStringAsync();
    Assert.Equal("[]", body); // no active session → GetSessionShoutoutsQueryHandler returns []
  }

  [Fact]
  public async Task GetSessionShoutoutsReturnsTheGroupedShoutouts()
  {
    var eventStore = Substitute.For<IStreamEventStore>();
    var sessionStore = Substitute.For<IStreamSessionStore>();
    _ = sessionStore.GetCurrentSessionIdAsync(Arg.Any<CancellationToken>()).Returns("session-1");
    IReadOnlyList<StreamEvent> events =
    [
      new StreamEvent(
        Id: "follow-1", Kind: "follow", Actor: "Viewer", Detail: "followed", Tone: "silver",
        ReceivedAt: DateTimeOffset.UtcNow, ActorLogin: "viewer", SessionId: "session-1"),
    ];
    _ = eventStore.GetSessionShoutoutEventsAsync(
      "session-1", Arg.Any<IReadOnlyList<string>>(), Arg.Any<CancellationToken>()).Returns(events);
    var client = new WebApplicationFactory<Program>()
      .WithWebHostBuilder(b =>
      {
        _ = b.UseSetting("Narya:DashboardToken", OperatorToken);
        _ = b.UseSetting("Narya:SkipInfrastructure", "true");
        _ = b.ConfigureTestServices(services =>
        {
          _ = services.AddSingleton(eventStore);
          _ = services.AddSingleton(sessionStore);
          _ = services.AddSingleton(Substitute.For<IViewerStore>());
          _ = services.AddSingleton(BuildDefaultAppConfigStore());
          _ = services.AddSingleton(Substitute.For<IChatStore>());
          _ = services.AddSingleton(Substitute.For<IAutomodStore>());
          _ = services.AddSingleton(Substitute.For<IMediaAssetStore>());
          _ = services.AddSingleton(Substitute.For<IActionStore>());
        });
      })
      .CreateClient();
    client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", OperatorToken);

    var response = await client.GetAsync("/api/dashboard/session-shoutouts");

    Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    var body = await response.Content.ReadAsStringAsync();
    Assert.Contains("\"actor\":\"Viewer\"", body);
    Assert.Contains("\"login\":\"viewer\"", body);
    Assert.Contains("\"kinds\":[\"follow\"]", body);
  }

  /// <summary>Operator-only — see <c>DashboardTokenMiddleware.OverlayPaths</c>, which deliberately never lists this route.</summary>
  [Fact]
  public async Task GetStatusIsForbiddenWithAnOverlayToken()
  {
    var client = BuildOperatorClient(Substitute.For<IStreamSessionStore>());
    var overlay = OverlayToken.Derive(OperatorToken);

    client.DefaultRequestHeaders.Authorization = null;
    var response = await client.GetAsync($"/api/dashboard/status?token={overlay}");

    Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
  }

  [Fact]
  public async Task GetStatusReturnsTheAggregatedSnapshot()
  {
    var sessionStore = Substitute.For<IStreamSessionStore>();
    _ = sessionStore.GetActiveSessionAsync(Arg.Any<CancellationToken>()).Returns(new StreamSession(
      Id: "session-1", StartedAt: DateTimeOffset.UtcNow, EndedAt: null, Source: "twitch:1",
      DiscordMessageId: null, DiscordChannelId: null, DiscordAnnounceError: null,
      DiscordAnnounceAttempts: 0, DiscordAnnounceTerminal: false));
    var client = BuildOperatorClient(sessionStore);

    var response = await client.GetAsync("/api/dashboard/status");

    Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    var body = await response.Content.ReadAsStringAsync();
    Assert.Contains("\"streamSessionId\":\"session-1\"", body);
    // Twitch auth/EventSub fields resolve through NullDashboardTwitchStatusProvider under
    // SkipInfrastructure (no AddNaryaTwitch) — "nothing configured" defaults, not an error.
    Assert.Contains("\"twitchAuthenticated\":false", body);
    Assert.Contains("\"eventSubConnected\":false", body);
    // OBS/ad-schedule fields default to null.
    Assert.Contains("\"obsConnected\":false", body);
    Assert.Contains("\"streamActive\":null", body);
  }
}
