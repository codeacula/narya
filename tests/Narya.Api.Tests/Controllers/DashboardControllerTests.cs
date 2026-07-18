using System.Net;
using System.Net.Http.Headers;

using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;

using NSubstitute;

using Narya.Api.Auth;
using Narya.Core.AppConfig;
using Narya.Core.Chat;
using Narya.Core.Events;
using Narya.Core.Sessions;

namespace Narya.Api.Tests.Controllers;

/// <summary>
/// Exercises <c>/api/dashboard/events</c> through the real MediatR pipeline — only
/// <see cref="IStreamEventStore"/> is substituted with a controlled instance (via
/// <c>ConfigureTestServices</c>), since <c>AddNaryaDatabase</c> is skipped under
/// <c>Narya:SkipInfrastructure=true</c>. <see cref="IAppConfigStore"/>/<see cref="IStreamSessionStore"/>/
/// <see cref="IChatStore"/> are also substituted (unconfigured — nothing here exercises them),
/// same reason as <c>ConfigControllerTests</c>. Unlike <c>GET /api/chat/recent</c>, this route is
/// operator-only — deliberately NOT on <c>DashboardTokenMiddleware.OverlayPaths</c> — so the
/// overlay-token case asserts 403, mirroring
/// <c>ChatControllerTests.GetRecentEventsIsForbiddenWithAnOverlayToken</c>.
/// </summary>
public sealed class DashboardControllerTests
{
  private const string OperatorToken = "op-token";

  private static HttpClient BuildOperatorClient(IStreamEventStore store)
  {
    var client = new WebApplicationFactory<Program>()
      .WithWebHostBuilder(b =>
      {
        _ = b.UseSetting("Narya:DashboardToken", OperatorToken);
        _ = b.UseSetting("Narya:SkipInfrastructure", "true");

        _ = b.ConfigureTestServices(services =>
        {
          _ = services.AddSingleton(store);
          _ = services.AddSingleton(Substitute.For<IAppConfigStore>());
          _ = services.AddSingleton(Substitute.For<IStreamSessionStore>());
          _ = services.AddSingleton(Substitute.For<IChatStore>());
        });
      })
      .CreateClient();

    client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", OperatorToken);
    return client;
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
}
