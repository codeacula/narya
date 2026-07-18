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
/// <see cref="TwitchEventSubService._reconnecting"/> is pre-latched in every test here (the same
/// internal-guard trick <c>TwitchEventSubServiceReconnectGuardTests</c> uses) so
/// <c>InvalidateAsync</c>'s fire-and-forget reconnect returns immediately instead of driving the
/// real <see cref="EventSubWebsocketClient"/>, which has no virtual members and would attempt an
/// actual connection to Twitch — something this suite never does.
/// </summary>
public sealed class TwitchEventSubServiceIdentityInvalidationTests
{
  private sealed record Fixture(TwitchEventSubService Service, IHelixClient HelixClient, IMediator Mediator);

  private static Fixture Build()
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
      _reconnecting = 1,
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
  public async Task InvalidatingRespectsTheReconnectReentrancyGuardInsteadOfStartingASecondLoop()
  {
    var f = Build();

    // The guard is already held (a backoff loop notionally in flight). Several invalidations
    // arriving at once — an operator saving Settings twice, a reauth immediately after — must
    // collapse into that single loop rather than each starting one of their own.
    await f.Service.InvalidateAsync(CancellationToken.None);
    await f.Service.InvalidateAsync(CancellationToken.None);

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
