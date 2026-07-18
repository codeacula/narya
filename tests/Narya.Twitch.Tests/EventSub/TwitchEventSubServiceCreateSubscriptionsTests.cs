using FluentResults;

using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;

using Narya.Twitch.EventSub;
using Narya.Twitch.Helix;

using TwitchLib.EventSub.Websockets;

namespace Narya.Twitch.Tests.EventSub;

/// <summary>
/// Exercises <see cref="TwitchEventSubService.CreateSubscriptionsAsync"/> against a substituted
/// <see cref="IHelixClient"/> — no real TwitchLib/network call ever happens (the real
/// <see cref="EventSubWebsocketClient"/> here is only a required constructor dependency; nothing
/// in these tests ever calls its own methods).
///
/// Covers two things reviewed into <c>TwitchEventSubService</c>'s Phase 2 Task 5 fix pass:
/// (1) subscription creation is routed through <see cref="IHelixClient.CreateEventSubWebsocketSubscriptionAsync"/>
/// per subscription — never a cached token/broadcaster-id shortcut — so a resubscribe always
/// resyncs a rotated Client ID; (2) <see cref="TwitchEventSubService.SubscriptionCreationOutcome.Attempted"/>
/// is false only when broadcaster-id resolution itself failed (nothing was attempted), and true
/// once the create loop actually ran — even if some/all individual subscriptions inside it
/// failed — matching <c>OnWebsocketConnectedAsync</c>'s use of it to decide whether a duplicate
/// <c>WebsocketConnected</c> for the same session should be retryable.
/// </summary>
public sealed class TwitchEventSubServiceCreateSubscriptionsTests
{
  private static TwitchEventSubService BuildService(IHelixClient helixClient) => new(
    new EventSubWebsocketClient(),
    Substitute.For<IEventSubSocket>(),
    helixClient,
    Substitute.For<IServiceScopeFactory>(),
    TimeProvider.System,
    NullLogger<TwitchEventSubService>.Instance);

  [Fact]
  public async Task BailsBeforeTheLoopWhenBroadcasterIdResolutionFails()
  {
    var helix = Substitute.For<IHelixClient>();
    _ = helix.GetBroadcasterIdAsync(Arg.Any<CancellationToken>()).Returns(Result.Fail<string>("Twitch channel is not configured."));
    var service = BuildService(helix);

    var outcome = await service.CreateSubscriptionsAsync("session-1", CancellationToken.None);

    Assert.False(outcome.Attempted);
    Assert.Equal(0, outcome.Created);
    _ = await helix.DidNotReceive().CreateEventSubWebsocketSubscriptionAsync(
      Arg.Any<string>(), Arg.Any<string>(), Arg.Any<IReadOnlyDictionary<string, string>>(), Arg.Any<string>(), Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task AttemptsAndCreatesEverySubscriptionWhenBroadcasterIdResolves()
  {
    var helix = Substitute.For<IHelixClient>();
    _ = helix.GetBroadcasterIdAsync(Arg.Any<CancellationToken>()).Returns(Result.Ok("bid-1"));
    _ = helix.CreateEventSubWebsocketSubscriptionAsync(
        Arg.Any<string>(), Arg.Any<string>(), Arg.Any<IReadOnlyDictionary<string, string>>(), "session-1", Arg.Any<CancellationToken>())
      .Returns(Result.Ok());
    var service = BuildService(helix);

    var outcome = await service.CreateSubscriptionsAsync("session-1", CancellationToken.None);

    Assert.True(outcome.Attempted);
    Assert.Equal(EventSubSubscriptions.All.Count, outcome.Created);
    _ = await helix.Received(EventSubSubscriptions.All.Count).CreateEventSubWebsocketSubscriptionAsync(
      Arg.Any<string>(), Arg.Any<string>(), Arg.Any<IReadOnlyDictionary<string, string>>(), "session-1", Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task StillCountsAsAttemptedWhenSomeIndividualSubscriptionsFail()
  {
    var helix = Substitute.For<IHelixClient>();
    _ = helix.GetBroadcasterIdAsync(Arg.Any<CancellationToken>()).Returns(Result.Ok("bid-1"));
    _ = helix.CreateEventSubWebsocketSubscriptionAsync(
        Arg.Is<string>(type => type == "channel.chat.message"), Arg.Any<string>(), Arg.Any<IReadOnlyDictionary<string, string>>(), "session-1", Arg.Any<CancellationToken>())
      .Returns(Result.Fail("Twitch rejected this subscription."));
    _ = helix.CreateEventSubWebsocketSubscriptionAsync(
        Arg.Is<string>(type => type != "channel.chat.message"), Arg.Any<string>(), Arg.Any<IReadOnlyDictionary<string, string>>(), "session-1", Arg.Any<CancellationToken>())
      .Returns(Result.Ok());
    var service = BuildService(helix);

    var outcome = await service.CreateSubscriptionsAsync("session-1", CancellationToken.None);

    // Best-effort: one rejected subscription must not stop the batch — attempted stays true,
    // and every OTHER subscription in the table still counts as created.
    Assert.True(outcome.Attempted);
    Assert.Equal(EventSubSubscriptions.All.Count - 1, outcome.Created);
  }

  [Fact]
  public async Task RoutesTheResolvedBroadcasterIdIntoEveryConditionRatherThanACachedShortcut()
  {
    var helix = Substitute.For<IHelixClient>();
    _ = helix.GetBroadcasterIdAsync(Arg.Any<CancellationToken>()).Returns(Result.Ok("bid-99"));
    _ = helix.CreateEventSubWebsocketSubscriptionAsync(
        Arg.Any<string>(), Arg.Any<string>(), Arg.Any<IReadOnlyDictionary<string, string>>(), Arg.Any<string>(), Arg.Any<CancellationToken>())
      .Returns(Result.Ok());
    var service = BuildService(helix);

    _ = await service.CreateSubscriptionsAsync("session-42", CancellationToken.None);

    // Every subscription is routed through CreateEventSubWebsocketSubscriptionAsync (never a
    // raw TwitchLib TwitchAPI call) carrying the resolved broadcaster id and the actual session
    // id — this is the seam Fix 2 introduced specifically so each call re-syncs ClientId.
    _ = await helix.Received(1).CreateEventSubWebsocketSubscriptionAsync(
      "channel.chat.message", "1",
      Arg.Is<IReadOnlyDictionary<string, string>>(c => c["broadcaster_user_id"] == "bid-99" && c["user_id"] == "bid-99"),
      "session-42", Arg.Any<CancellationToken>());
  }
}
