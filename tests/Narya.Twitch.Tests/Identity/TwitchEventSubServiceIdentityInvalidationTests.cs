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
using TwitchLib.EventSub.Websockets.Core.EventArgs;

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
/// These tests assert that as an OUTCOME — <see cref="IEventSubSocket.ReconnectAsync"/> was
/// driven, and the resulting connect created subscriptions whose condition carries the NEW
/// broadcaster id — rather than by reading a production counter that recorded a reconnect had
/// been REQUESTED. A counter can be incremented by code that then does nothing; this cannot.
/// (That counter, <c>_reconnectRequests</c>, existed only for the previous version of these
/// tests and is gone; <see cref="IEventSubSocket"/> replaced it, because the concrete TwitchLib
/// <see cref="EventSubWebsocketClient"/> has no virtual members and cannot be substituted.)
///
/// No test here opens a socket: <see cref="IEventSubSocket"/> is substituted, and the
/// <c>WebsocketConnected</c> event the real client would raise after a successful reconnect is
/// delivered by calling <c>OnWebsocketConnectedAsync</c> directly.
/// </summary>
public sealed class TwitchEventSubServiceIdentityInvalidationTests
{
  private sealed record Fixture(
    TwitchEventSubService Service, IHelixClient HelixClient, IMediator Mediator, IEventSubSocket Socket);

  private static Fixture Build(
    int reconnecting = 1, IEventSubSocket? socket = null, CancellationToken stoppingToken = default)
  {
    var helixClient = Substitute.For<IHelixClient>();
    var mediator = Substitute.For<IMediator>();
    socket ??= Substitute.For<IEventSubSocket>();

    var serviceProvider = Substitute.For<IServiceProvider>();
    _ = serviceProvider.GetService(typeof(IMediator)).Returns(mediator);
    var scope = Substitute.For<IServiceScope>();
    _ = scope.ServiceProvider.Returns(serviceProvider);
    var scopeFactory = Substitute.For<IServiceScopeFactory>();
    _ = scopeFactory.CreateScope().Returns(scope);

    var service = new TwitchEventSubService(
      new EventSubWebsocketClient(), socket, helixClient, scopeFactory, TimeProvider.System,
      NullLogger<TwitchEventSubService>.Instance)
    {
      // Park the reconnect loop — see the class doc comment.
      _reconnecting = reconnecting,
      _stoppingToken = stoppingToken,
    };

    return new Fixture(service, helixClient, mediator, socket);
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

  /// <summary>
  /// THE OUTCOME, not the request. The defect this whole task exists to fix: without a reconnect,
  /// a channel switch clears the cached bot login but leaves every EventSub subscription — all
  /// conditioned on the OLD broadcaster id — bound to the previous channel until the process
  /// restarts.
  ///
  /// <para>
  /// Both connects below use the SAME session id on purpose. <c>ShouldResubscribe</c> compares the
  /// new session id against <c>_lastSubscribedSessionId</c>, so an identical id resubscribes ONLY
  /// because <c>InvalidateAsync</c> cleared that field. Deleting either half of the fix — the
  /// fire-and-forget reconnect, or the <c>_lastSubscribedSessionId = null</c> — leaves the second
  /// connect a no-op and fails this test, which a counter assertion could not distinguish.
  /// </para>
  /// </summary>
  [Fact]
  public async Task InvalidatingResubscribesAgainstTheNewBroadcasterInsteadOfTheOldChannel()
  {
    var socket = Substitute.For<IEventSubSocket>();
    _ = socket.SessionId.Returns("session-1");
    _ = socket.ReconnectAsync().Returns(true);

    var f = Build(reconnecting: 0, socket: socket);
    _ = f.HelixClient.CreateEventSubWebsocketSubscriptionAsync(
        Arg.Any<string>(), Arg.Any<string>(), Arg.Any<IReadOnlyDictionary<string, string>>(),
        Arg.Any<string>(), Arg.Any<CancellationToken>())
      .Returns(Result.Ok());

    // The live process before the switch: connected, subscribed against the old broadcaster.
    _ = f.HelixClient.GetBroadcasterIdAsync(Arg.Any<CancellationToken>()).Returns(Result.Ok("old-bid"));
    await f.Service.OnWebsocketConnectedAsync(sender: null, new WebsocketConnectedArgs { IsRequestedReconnect = false });

    _ = await f.HelixClient.Received(EventSubSubscriptions.All.Count).CreateEventSubWebsocketSubscriptionAsync(
      Arg.Any<string>(), Arg.Any<string>(),
      Arg.Is<IReadOnlyDictionary<string, string>>(c => c.Values.Contains("old-bid")),
      Arg.Any<string>(), Arg.Any<CancellationToken>());

    // The operator points Narya at a different channel.
    _ = f.HelixClient.GetBroadcasterIdAsync(Arg.Any<CancellationToken>()).Returns(Result.Ok("new-bid"));
    await f.Service.InvalidateAsync(CancellationToken.None);

    // The invalidation drove a real reconnect through the socket...
    _ = await socket.Received().ReconnectAsync();

    // ...and the connect that reconnect produces re-creates every subscription against the NEW
    // broadcaster. This is the assertion that actually protects the user-visible behavior.
    await f.Service.OnWebsocketConnectedAsync(sender: null, new WebsocketConnectedArgs { IsRequestedReconnect = false });

    _ = await f.HelixClient.Received(EventSubSubscriptions.All.Count).CreateEventSubWebsocketSubscriptionAsync(
      Arg.Any<string>(), Arg.Any<string>(),
      Arg.Is<IReadOnlyDictionary<string, string>>(c => c.Values.Contains("new-bid")),
      Arg.Any<string>(), Arg.Any<CancellationToken>());
  }

  /// <summary>
  /// THE SWALLOWED-INVALIDATION RACE. <c>ReconnectWithBackoffAsync</c>'s reentrancy guard used to
  /// clear the moment <c>ReconnectAsync</c> returned true — but the re-subscription it triggers
  /// happens LATER and asynchronously, in <c>OnWebsocketConnectedAsync</c>. An invalidation
  /// landing in that tail window hit the guard, returned having done nothing, and the in-flight
  /// reconnect went on to resubscribe against the broadcaster it had resolved BEFORE the
  /// invalidation — leaving every subscription on the previous channel until the next socket drop
  /// or a restart.
  ///
  /// <para>
  /// The race is made deterministic by invalidating from INSIDE the first
  /// <c>ReconnectAsync</c> call, which is precisely "an invalidation arriving while a loop owns
  /// the guard". The fix defers rather than drops it, so the loop must run a SECOND attempt after
  /// releasing the guard. Against the pre-fix code this observes exactly one call and fails.
  /// </para>
  /// </summary>
  [Fact]
  public async Task AnInvalidationArrivingWhileAReconnectLoopOwnsTheGuardIsDeferredNotDropped()
  {
    var socket = Substitute.For<IEventSubSocket>();
    _ = socket.SessionId.Returns("session-1");

    TwitchEventSubService? service = null;
    var attempts = 0;
    _ = socket.ReconnectAsync().Returns(_ =>
    {
      attempts++;
      if (attempts == 1)
      {
        // The invalidation lands mid-flight, with the guard held by this very loop.
        service!.InvalidateAsync(CancellationToken.None).GetAwaiter().GetResult();
      }

      return true;
    });

    var f = Build(reconnecting: 0, socket: socket);
    service = f.Service;

    // A hard socket drop starts the loop.
    await f.Service.ReconnectWithBackoffAsync(CancellationToken.None);

    Assert.Equal(2, attempts);
    _ = await socket.Received(2).ReconnectAsync();

    // The guard is left released, not stuck held, after draining the deferred request.
    Assert.Equal(0, f.Service._reconnecting);
  }

  /// <summary>
  /// The other side of the same coin: repeated invalidations while a loop is in flight must
  /// collapse into ONE extra pass, not start a reconnect storm of their own. Three invalidations
  /// arriving during the first attempt (an operator saving Settings twice, a reauth right after)
  /// leave the flag set once, so the loop runs exactly one more attempt.
  /// </summary>
  [Fact]
  public async Task RepeatedInvalidationsDuringOneLoopCollapseIntoASingleExtraPass()
  {
    var socket = Substitute.For<IEventSubSocket>();
    _ = socket.SessionId.Returns("session-1");

    TwitchEventSubService? service = null;
    var attempts = 0;
    _ = socket.ReconnectAsync().Returns(_ =>
    {
      attempts++;
      if (attempts == 1)
      {
        for (var i = 0; i < 3; i++)
        {
          service!.InvalidateAsync(CancellationToken.None).GetAwaiter().GetResult();
        }
      }

      return true;
    });

    var f = Build(reconnecting: 0, socket: socket);
    service = f.Service;

    await f.Service.ReconnectWithBackoffAsync(CancellationToken.None);

    Assert.Equal(2, attempts);
    Assert.Equal(0, f.Service._reconnecting);
  }

  /// <summary>
  /// THE SIGN-OUT CASE, as opposed to the reauth case above. After the operator DISCONNECTS the
  /// bot there is no bot account at all, so the resolution fails rather than returning a different
  /// login. The bot-loop guard must fall open — suppress nothing — rather than keep filtering the
  /// login it last saw.
  ///
  /// <para>
  /// This is the user-visible harm behind the sign-out fix in <c>TwitchAuthController</c>: with a
  /// stale <c>_cachedBotLogin</c>, any VIEWER whose login happens to match the disconnected bot's
  /// name has every message silently dropped, and nothing is logged to explain it.
  /// </para>
  /// </summary>
  [Fact]
  public async Task AfterTheBotIsDisconnectedTheOldBotLoginIsNoLongerSuppressed()
  {
    var f = Build();
    _ = f.HelixClient.GetAuthenticatedUserAsync(TwitchProvider.Bot, Arg.Any<CancellationToken>())
      .Returns(Result.Ok(new HelixUser { Id = "bot-1", Login = "naryabot" }));

    // While the bot is connected its own messages are correctly suppressed.
    await f.Service.OnChatMessageAsync(sender: null, ChatMessageArgs("naryabot"));
    await f.Mediator.DidNotReceive().Publish(Arg.Any<ChatMessageIngestedNotification>(), Arg.Any<CancellationToken>());

    // The operator signs the bot out: the token is gone, so resolution now fails.
    _ = f.HelixClient.GetAuthenticatedUserAsync(TwitchProvider.Bot, Arg.Any<CancellationToken>())
      .Returns(Result.Fail<HelixUser>("Twitch bot account is not connected."));
    await f.Service.InvalidateAsync(CancellationToken.None);

    // A viewer using that same login must now be treated as an ordinary chatter.
    await f.Service.OnChatMessageAsync(sender: null, ChatMessageArgs("naryabot"));
    await f.Mediator.Received(1).Publish(
      Arg.Is<ChatMessageIngestedNotification>(n => n.Message.Username == "naryabot"), Arg.Any<CancellationToken>());
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
