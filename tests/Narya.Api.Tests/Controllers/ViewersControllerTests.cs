using System.Net;
using System.Net.Http.Headers;

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

namespace Narya.Api.Tests.Controllers;

/// <summary>
/// Exercises <c>/api/viewers/roster</c> and <c>/api/viewers/{login}/messages</c> through the
/// real MediatR pipeline — only <see cref="IViewerStore"/>/<see cref="IChatStore"/> are
/// substituted with controlled instances (via <c>ConfigureTestServices</c>), since
/// <c>AddNaryaDatabase</c> is skipped under <c>Narya:SkipInfrastructure=true</c>.
/// <see cref="IAppConfigStore"/>/<see cref="IStreamSessionStore"/>/<see cref="IStreamEventStore"/>
/// are also substituted (unconfigured — nothing here exercises them), same reason as
/// <c>ConfigControllerTests</c>. Both routes are operator-only — deliberately NOT on
/// <c>DashboardTokenMiddleware.OverlayPaths</c> — so the overlay-token case asserts 403.
/// </summary>
public sealed class ViewersControllerTests
{
  private const string OperatorToken = "op-token";

  private static HttpClient BuildOperatorClient(IViewerStore? viewerStore = null, IChatStore? chatStore = null)
  {
    var client = new WebApplicationFactory<Program>()
      .WithWebHostBuilder(b =>
      {
        _ = b.UseSetting("Narya:DashboardToken", OperatorToken);
        _ = b.UseSetting("Narya:SkipInfrastructure", "true");

        _ = b.ConfigureTestServices(services =>
        {
          _ = services.AddSingleton(viewerStore ?? Substitute.For<IViewerStore>());
          _ = services.AddSingleton(chatStore ?? Substitute.For<IChatStore>());
          _ = services.AddSingleton(Substitute.For<IAppConfigStore>());
          _ = services.AddSingleton(Substitute.For<IStreamSessionStore>());
          _ = services.AddSingleton(Substitute.For<IStreamEventStore>());
          _ = services.AddSingleton(Substitute.For<IAutomodStore>());
          _ = services.AddSingleton(Substitute.For<IMediaAssetStore>());
          _ = services.AddSingleton(Substitute.For<IActionStore>());
          _ = services.AddSingleton(Substitute.For<IMediaResolver>());
          _ = services.AddSingleton(Substitute.For<IHelixClient>());
          _ = services.AddSingleton(Substitute.For<IMediaMuteStore>());
          _ = services.AddSingleton(Substitute.For<IAutomationTriggerStore>());
          _ = services.AddSingleton(Substitute.For<IAutomationRunStore>());
        });
      })
      .CreateClient();

    client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", OperatorToken);
    return client;
  }

  [Fact]
  public async Task GetRosterReturnsTheStoresRoster()
  {
    var store = Substitute.For<IViewerStore>();
    var firstSeenAt = DateTimeOffset.Parse("2026-01-01T00:00:00Z", System.Globalization.CultureInfo.InvariantCulture);
    var lastSeenAt = firstSeenAt.AddDays(1);
    IReadOnlyList<ViewerRosterEntry> roster =
    [
      new ViewerRosterEntry(
        Login: "viewer", Display: "Viewer", Color: "#111111", Roles: ["sub"],
        MessageCount: 3, FirstSeenAt: firstSeenAt, LastSeenAt: lastSeenAt, Note: "a note"),
    ];
    _ = store.GetRosterAsync(Arg.Any<CancellationToken>()).Returns(roster);
    var client = BuildOperatorClient(viewerStore: store);

    var response = await client.GetAsync("/api/viewers/roster");

    Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    var body = await response.Content.ReadAsStringAsync();
    Assert.Contains("\"login\":\"viewer\"", body);
    Assert.Contains("\"note\":\"a note\"", body);
  }

  [Fact]
  public async Task GetRosterIsForbiddenWithAnOverlayToken()
  {
    var store = Substitute.For<IViewerStore>();
    var client = BuildOperatorClient(viewerStore: store);
    var overlay = OverlayToken.Derive(OperatorToken);

    client.DefaultRequestHeaders.Authorization = null;
    var response = await client.GetAsync($"/api/viewers/roster?token={overlay}");

    Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    _ = await store.DidNotReceive().GetRosterAsync(Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task GetMessagesReturnsTheStoresMessagesForThatLogin()
  {
    var store = Substitute.For<IChatStore>();
    IReadOnlyList<ChatMessage> messages =
    [
      new ChatMessage(
        Id: "msg-1", Channel: "codeacula", Username: "viewer", DisplayName: "Viewer",
        Color: null, Message: "hi", ReceivedAt: DateTimeOffset.UtcNow, Badges: null, ChatterUserId: "viewer-id-1"),
    ];
    _ = store.GetMessagesByUsernameAsync("viewer", null, 80, Arg.Any<CancellationToken>()).Returns(messages);
    var client = BuildOperatorClient(chatStore: store);

    var response = await client.GetAsync("/api/viewers/viewer/messages");

    Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    var body = await response.Content.ReadAsStringAsync();
    Assert.Contains("\"id\":\"msg-1\"", body);
  }

  [Fact]
  public async Task GetMessagesPassesTheBeforeQueryParameterThrough()
  {
    var store = Substitute.For<IChatStore>();
    _ = store.GetMessagesByUsernameAsync("viewer", "msg-5", 80, Arg.Any<CancellationToken>())
      .Returns([]);
    var client = BuildOperatorClient(chatStore: store);

    var response = await client.GetAsync("/api/viewers/viewer/messages?before=msg-5");

    Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    _ = await store.Received(1).GetMessagesByUsernameAsync("viewer", "msg-5", 80, Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task GetMessagesIsForbiddenWithAnOverlayToken()
  {
    var store = Substitute.For<IChatStore>();
    var client = BuildOperatorClient(chatStore: store);
    var overlay = OverlayToken.Derive(OperatorToken);

    client.DefaultRequestHeaders.Authorization = null;
    var response = await client.GetAsync($"/api/viewers/viewer/messages?token={overlay}");

    Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    _ = await store.DidNotReceive().GetMessagesByUsernameAsync(
      Arg.Any<string>(), Arg.Any<string?>(), Arg.Any<int>(), Arg.Any<CancellationToken>());
  }
}
