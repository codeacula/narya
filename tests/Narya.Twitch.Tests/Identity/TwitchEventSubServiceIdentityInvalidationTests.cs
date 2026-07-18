using FluentResults;

using MediatR;

using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;

using Narya.Core.Chat;
using Narya.Twitch.EventSub;
using Narya.Twitch.EventSub.Notifications;
using Narya.Twitch.Helix;

using TwitchLib.EventSub.Core.EventArgs.Channel;
using TwitchLib.EventSub.Core.Models;
using TwitchLib.EventSub.Core.SubscriptionTypes.Channel;

using TwitchLib.EventSub.Websockets;

namespace Narya.Twitch.Tests.Identity;

/// <summary>
/// The security-relevant half of the Twitch identity invalidation: the bot-loop guard in
/// <see cref="TwitchEventSubService.OnChatMessageAsync"/> suppresses a chat message whose author
/// matches the cached bot login. That login was cached for the process lifetime, so an operator
/// who reconnected a DIFFERENT bot account kept a guard pointed at the PREVIOUS bot — the new
/// bot's own messages sailed straight through as if a viewer had sent them, re-triggering every
/// chat automation they matched. These tests assert both directions across an invalidation: the
/// old login stops being suppressed, and the new one starts.
///
/// The other half is the EventSub reconnect: subscriptions are all conditioned on the broadcaster
/// id, so an invalidation that does not reconnect leaves them bound to the old channel forever.
/// <see cref="TwitchEventSubService._reconnectRequests"/> is the seam that makes that observable
/// — the real <see cref="EventSubWebsocketClient"/> has no virtual members and cannot be
/// substituted, and this suite never opens a socket to Twitch.
///
/// <see cref="TwitchEventSubService._reconnecting"/> is pre-latched by default here (the same
/// internal-guard trick <c>TwitchEventSubServiceReconnectGuardTests</c> uses) so
/// <c>InvalidateAsync</c>'s fire-and-forget reconnect returns immediately instead of driving that
/// client. The one test that needs the loop genuinely entered starts from a free guard and an
/// already-cancelled stopping token, which makes it return at its first cancellation check.
/// </summary>
public sealed class TwitchEventSubServiceIdentityInvalidationTests
{
  private sealed record Fixture(TwitchEventSubService Service, IHelixClient HelixClient, IMediator Mediator);

  private static Fixture Build(int reconnecting = 1, CancellationToken stoppingToken = default)
  {
    var helixClient = Substitute.For<IHelixClient>();
    var mediator = Substitute.For<IMediator>();

    var serviceProvider = Substitute.For<IServiceProvider>();
    _ = serviceProvider.GetService(typeof(IMediator)).Returns(mediator);
    var scope = Substitute.For<IServiceScope>();
    _ = scope.ServiceProvider.Returns(serviceProvider);
    var scopeFactory = Substitute.For<IServiceScopeFactory>();
    _ = scopeFactory.CreateScope().Returns(scope);

    var service = new TwitchEventSubService(
      new EventSubWebsocketClient(), helixClient, scopeFactory, TimeProvider.System,
      NullLogger<TwitchEventSubService>.Instance)
    {
      // Park the reconnect loop — see the class doc comment.
      _reconnecting = reconnecting,
      _stoppingToken = stoppingToken,
    };

    return new Fixture(service, helixClient, mediator);
  }

  [Fact]
  public async Task InvalidatingAfterABotReauthMovesTheBotLoopGuardToTheNewBot()
  {
    var f = Build();
    _ = f.HelixClient.GetAuthenticatedUserAsync(TwitchProvider.Bot, Arg.Any<CancellationToken>())
      .Returns(Result.Ok(new HelixUser { Id = "bot-1", Login = "oldbot" }));

    // Prime the cache the way a live process would: one chat message from the old bot, correctly
    // suppressed.
    await f.Service.OnChatMessageAsync(sender: null, ChatMessageArgs("oldbot"));
    await f.Mediator.DidNotReceive().Publish(Arg.Any<ChatMessageIngestedNotification>(), Arg.Any<CancellationToken>());

    // The operator reconnects a different bot account.
    _ = f.HelixClient.GetAuthenticatedUserAsync(TwitchProvider.Bot, Arg.Any<CancellationToken>())
      .Returns(Result.Ok(new HelixUser { Id = "bot-2", Login = "newbot" }));
    await f.Service.InvalidateAsync(CancellationToken.None);

    // The NEW bot's own message must now be suppressed...
    await f.Service.OnChatMessageAsync(sender: null, ChatMessageArgs("NewBot"));
    await f.Mediator.DidNotReceive().Publish(Arg.Any<ChatMessageIngestedNotification>(), Arg.Any<CancellationToken>());

    // ...and the OLD bot, now just another chat account, must not be.
    await f.Service.OnChatMessageAsync(sender: null, ChatMessageArgs("oldbot"));
    await f.Mediator.Received(1).Publish(
      Arg.Is<ChatMessageIngestedNotification>(n => n.Message.Username == "oldbot"), Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task InvalidatingForcesAReResolutionOfTheBotLogin()
  {
    var f = Build();
    _ = f.HelixClient.GetAuthenticatedUserAsync(TwitchProvider.Bot, Arg.Any<CancellationToken>())
      .Returns(Result.Ok(new HelixUser { Id = "bot-1", Login = "naryabot" }));

    _ = await f.Service.GetBotLoginAsync(CancellationToken.None);
    _ = await f.Service.GetBotLoginAsync(CancellationToken.None);
    _ = await f.HelixClient.Received(1).GetAuthenticatedUserAsync(TwitchProvider.Bot, Arg.Any<CancellationToken>());

    await f.Service.InvalidateAsync(CancellationToken.None);
    _ = await f.Service.GetBotLoginAsync(CancellationToken.None);

    _ = await f.HelixClient.Received(2).GetAuthenticatedUserAsync(TwitchProvider.Bot, Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task InvalidatingRequestsAnEventSubReconnectSoSubscriptionsRebindToTheNewChannel()
  {
    // The defect this whole task exists to fix: without the reconnect, a channel switch clears
    // the cached bot login but leaves every EventSub subscription — all conditioned on the OLD
    // broadcaster id — in place until the process restarts. The guard starts FREE here so the
    // backoff loop is genuinely entered; the stopping token is already cancelled so the loop
    // returns at its first cancellation check, before it would touch the real websocket client.
    using var cancelled = new CancellationTokenSource();
    await cancelled.CancelAsync();
    var f = Build(reconnecting: 0, stoppingToken: cancelled.Token);

    await f.Service.InvalidateAsync(CancellationToken.None);

    // The load-bearing assertion: the backoff loop was actually entered. Deleting the
    // fire-and-forget reconnect from InvalidateAsync leaves this at 0.
    Assert.Equal(1, f.Service._reconnectRequests);

    // ...and it took and released the guard rather than bailing out at it.
    Assert.Equal(0, f.Service._reconnecting);
  }

  [Fact]
  public async Task InvalidatingRespectsTheReconnectReentrancyGuardInsteadOfStartingASecondLoop()
  {
    var f = Build();

    // The guard is already held (a backoff loop notionally in flight). Several invalidations
    // arriving at once — an operator saving Settings twice, a reauth immediately after — must
    // collapse into that single loop rather than each starting one of their own.
    await f.Service.InvalidateAsync(CancellationToken.None);
    await f.Service.InvalidateAsync(CancellationToken.None);

    // Both invalidations DID ask for a reconnect — without this the assertion below is
    // satisfied just as well by a build that never requests one at all.
    Assert.Equal(2, f.Service._reconnectRequests);

    // Untouched: only the loop that acquired the guard is allowed to release it. Had these
    // calls run the loop body, its `finally` would have reset this to 0.
    Assert.Equal(1, f.Service._reconnecting);
  }

  /// <summary>Same canned shape as <c>TwitchEventSubServiceDispatchTests.ChatMessageArgs</c>.</summary>
  private static ChannelChatMessageArgs ChatMessageArgs(string chatterLogin) => new()
  {
    Payload = new EventSubNotificationPayload<ChannelChatMessage>
    {
      Event = new ChannelChatMessage
      {
        ChatterUserLogin = chatterLogin,
        ChatterUserName = chatterLogin,
        MessageId = Guid.NewGuid().ToString(),
        Message = new TwitchLib.EventSub.Core.Models.Chat.ChatMessage { Text = "hello", Fragments = [] },
        Badges = [],
      },
    },
  };
}
