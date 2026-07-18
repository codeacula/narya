using System.Net;
using System.Net.Http.Headers;
using System.Text.Json;

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
/// Exercises <c>/api/chat/recent</c> and <c>/api/chat/events/recent</c> through the real MediatR
/// pipeline — only <see cref="IChatStore"/> is substituted (via <c>ConfigureTestServices</c>),
/// since <c>AddNaryaDatabase</c> is skipped under <c>Narya:SkipInfrastructure=true</c>.
/// <see cref="IAppConfigStore"/>/<see cref="IStreamSessionStore"/>/<see cref="IStreamEventStore"/>/
/// <see cref="IViewerStore"/> are also substituted (unconfigured — nothing here exercises them),
/// same reason as <c>ConfigControllerTests</c>.
/// </summary>
public sealed class ChatControllerTests
{
  private const string OperatorToken = "op-token";

  private static HttpClient BuildOperatorClient(IChatStore store)
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
      })
      .CreateClient();

    client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", OperatorToken);
    return client;
  }

  [Fact]
  public async Task GetRecentReturnsTheStoresMessages()
  {
    var store = Substitute.For<IChatStore>();
    IReadOnlyList<ChatMessage> messages =
    [
      new ChatMessage(
        Id: "msg-1", Channel: "codeacula", Username: "viewer", DisplayName: "Viewer",
        Color: null, Message: "hi", ReceivedAt: DateTimeOffset.UtcNow, Badges: null, ChatterUserId: "viewer-id-1"),
    ];
    _ = store.GetRecentMessagesAsync(40, Arg.Any<CancellationToken>()).Returns(messages);
    var client = BuildOperatorClient(store);

    var response = await client.GetAsync("/api/chat/recent");

    Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    var body = await response.Content.ReadAsStringAsync();
    Assert.Contains("\"id\":\"msg-1\"", body);
    Assert.Contains("\"username\":\"viewer\"", body);
  }

  [Fact]
  public async Task GetRecentIncludesDeletedAtAndDeletedReasonForAModeratedMessage()
  {
    var store = Substitute.For<IChatStore>();
    var deletedAt = DateTimeOffset.Parse("2026-07-17T12:00:00Z", System.Globalization.CultureInfo.InvariantCulture);
    IReadOnlyList<ChatMessage> messages =
    [
      new ChatMessage(
        Id: "msg-1", Channel: "codeacula", Username: "spammer", DisplayName: "Spammer",
        Color: null, Message: "hi", ReceivedAt: DateTimeOffset.UtcNow, Badges: null, ChatterUserId: "spammer-id-1",
        DeletedAt: deletedAt, DeletedReason: "message deleted by moderator"),
    ];
    _ = store.GetRecentMessagesAsync(40, Arg.Any<CancellationToken>()).Returns(messages);
    var client = BuildOperatorClient(store);

    var response = await client.GetAsync("/api/chat/recent");

    Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    var body = await response.Content.ReadAsStringAsync();
    Assert.Contains("\"deletedReason\":\"message deleted by moderator\"", body);
    Assert.Contains("\"deletedAt\":\"2026-07-17T12:00:00", body);
  }

  [Fact]
  public async Task GetRecentIsAccessibleWithAnOverlayToken()
  {
    var store = Substitute.For<IChatStore>();
    IReadOnlyList<ChatMessage> messages = [];
    _ = store.GetRecentMessagesAsync(40, Arg.Any<CancellationToken>()).Returns(messages);
    var client = BuildOperatorClient(store);
    var overlay = OverlayToken.Derive(OperatorToken);

    client.DefaultRequestHeaders.Authorization = null;
    var response = await client.GetAsync($"/api/chat/recent?token={overlay}");

    Assert.Equal(HttpStatusCode.OK, response.StatusCode);
  }

  [Fact]
  public async Task GetRecentEventsReturnsTheStoresEvents()
  {
    var store = Substitute.For<IChatStore>();
    IReadOnlyList<ChatEvent> events =
    [
      new ChatEvent(
        Id: Guid.Parse("11111111-1111-1111-1111-111111111111"), Type: "message.created", Channel: "codeacula",
        MessageId: "msg-1", Username: "viewer", Payload: JsonDocument.Parse("{}").RootElement, OccurredAt: DateTimeOffset.UtcNow),
    ];
    _ = store.GetRecentEventsAsync(100, Arg.Any<CancellationToken>()).Returns(events);
    var client = BuildOperatorClient(store);

    var response = await client.GetAsync("/api/chat/events/recent");

    Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    var body = await response.Content.ReadAsStringAsync();
    Assert.Contains("\"type\":\"message.created\"", body);
  }

  [Fact]
  public async Task GetRecentEventsIsForbiddenWithAnOverlayToken()
  {
    var store = Substitute.For<IChatStore>();
    var client = BuildOperatorClient(store);
    var overlay = OverlayToken.Derive(OperatorToken);

    client.DefaultRequestHeaders.Authorization = null;
    var response = await client.GetAsync($"/api/chat/events/recent?token={overlay}");

    Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    _ = await store.DidNotReceive().GetRecentEventsAsync(Arg.Any<int>(), Arg.Any<CancellationToken>());
  }
}
