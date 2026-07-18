using FluentResults;

using MediatR;

using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;

using Narya.Twitch.EventSub;
using Narya.Twitch.EventSub.Notifications;
using Narya.Twitch.Helix;

using TwitchLib.EventSub.Core.EventArgs.Channel;
using TwitchLib.EventSub.Core.Models;
using TwitchLib.EventSub.Core.SubscriptionTypes.Channel;
using TwitchLib.EventSub.Websockets;

namespace Narya.Twitch.Tests.EventSub;

/// <summary>
/// Exercises how <see cref="TwitchEventSubService"/> wires <see cref="EventSubDispatcher"/>'s
/// pure output to <see cref="IMediator.Publish"/>. The handler methods under test are
/// <c>internal</c> for the same reason <see cref="TwitchEventSubService.ReconnectWithBackoffAsync"/>
/// and <see cref="TwitchEventSubService.CreateSubscriptionsAsync"/> already are: the real
/// <see cref="EventSubWebsocketClient"/> has no virtual members, so a test cannot raise a real
/// <c>ChannelChatMessage</c> event on it — invoking the handler directly, with a canned
/// <c>*Args</c> POCO and a substituted <see cref="IServiceScopeFactory"/>/<see cref="IMediator"/>,
/// is the only way to prove the wiring without opening a socket.
/// </summary>
public sealed class TwitchEventSubServiceDispatchTests
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
      new EventSubWebsocketClient(), helixClient, scopeFactory, TimeProvider.System, NullLogger<TwitchEventSubService>.Instance);

    return new Fixture(service, helixClient, mediator);
  }

  [Fact]
  public async Task OnChatMessageAsyncPublishesTheDispatchedNotificationThroughAFreshScope()
  {
    var f = Build();
    _ = f.HelixClient.GetAuthenticatedUserAsync(TwitchProvider.Bot, Arg.Any<CancellationToken>())
      .Returns(Result.Fail<HelixUser>("bot not configured"));
    var args = ChatMessageArgs(chatterLogin: "someviewer");

    await f.Service.OnChatMessageAsync(sender: null, args);

    await f.Mediator.Received(1).Publish(
      Arg.Is<ChatMessageReceivedNotification>(n => n.Message.Username == "someviewer"), Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task OnChatMessageAsyncNeverPublishesForTheBotsOwnMessage()
  {
    var f = Build();
    _ = f.HelixClient.GetAuthenticatedUserAsync(TwitchProvider.Bot, Arg.Any<CancellationToken>())
      .Returns(Result.Ok(new HelixUser { Id = "bot-id", Login = "naryabot" }));
    var args = ChatMessageArgs(chatterLogin: "NaryaBot");

    await f.Service.OnChatMessageAsync(sender: null, args);

    await f.Mediator.DidNotReceive().Publish(Arg.Any<ChatMessageReceivedNotification>(), Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task GetBotLoginAsyncCachesASuccessfulResolutionAcrossCalls()
  {
    var f = Build();
    _ = f.HelixClient.GetAuthenticatedUserAsync(TwitchProvider.Bot, Arg.Any<CancellationToken>())
      .Returns(Result.Ok(new HelixUser { Id = "bot-id", Login = "naryabot" }));

    var first = await f.Service.GetBotLoginAsync(CancellationToken.None);
    var second = await f.Service.GetBotLoginAsync(CancellationToken.None);

    Assert.Equal("naryabot", first);
    Assert.Equal("naryabot", second);
    _ = await f.HelixClient.Received(1).GetAuthenticatedUserAsync(TwitchProvider.Bot, Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task GetBotLoginAsyncDoesNotCacheAFailedResolutionSoALaterConfiguredBotIsPickedUp()
  {
    var f = Build();
    _ = f.HelixClient.GetAuthenticatedUserAsync(TwitchProvider.Bot, Arg.Any<CancellationToken>())
      .Returns(Result.Fail<HelixUser>("bot not configured"), Result.Ok(new HelixUser { Id = "bot-id", Login = "naryabot" }));

    var first = await f.Service.GetBotLoginAsync(CancellationToken.None);
    var second = await f.Service.GetBotLoginAsync(CancellationToken.None);

    Assert.Null(first);
    Assert.Equal("naryabot", second);
    _ = await f.HelixClient.Received(2).GetAuthenticatedUserAsync(TwitchProvider.Bot, Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task AHandlerSwallowsAPublishFailureRatherThanThrowing()
  {
    var f = Build();
    _ = f.HelixClient.GetAuthenticatedUserAsync(TwitchProvider.Bot, Arg.Any<CancellationToken>())
      .Returns(Result.Fail<HelixUser>("bot not configured"));
    _ = f.Mediator.Publish(Arg.Any<object>(), Arg.Any<CancellationToken>())
      .Returns(Task.FromException(new InvalidOperationException("a downstream MediatR handler blew up")));
    var args = ChatMessageArgs(chatterLogin: "someviewer");

    var exception = await Record.ExceptionAsync(() => f.Service.OnChatMessageAsync(sender: null, args));

    Assert.Null(exception);
  }

  [Fact]
  public async Task SubscribeThenSubscriptionMessageWithinTheWindowMergesIntoAnUpdateNotInsteadOfANewEvent()
  {
    var f = Build();
    var subscribeArgs = SubscribeArgs(userId: "42", userName: "Resubber", tier: "1000");
    var messageArgs = SubscriptionMessageArgs(userId: "42", userName: "Resubber", tier: "1000", cumulativeMonths: 3);

    await f.Service.OnChannelSubscribeAsync(sender: null, subscribeArgs);
    await f.Service.OnChannelSubscriptionMessageAsync(sender: null, messageArgs);

    await f.Mediator.Received(1).Publish(Arg.Any<StreamEventOccurredNotification>(), Arg.Any<CancellationToken>());
    await f.Mediator.Received(1).Publish(
      Arg.Is<StreamEventUpdatedNotification>(n => n.Update.Detail == "resub · Tier 1 · 3 months"), Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task SubscriptionMessageWithNoPrecedingSubscribeEmitsANewStreamEventInstead()
  {
    var f = Build();
    var messageArgs = SubscriptionMessageArgs(userId: "77", userName: "MonthlyResubber", tier: "1000", cumulativeMonths: 6);

    await f.Service.OnChannelSubscriptionMessageAsync(sender: null, messageArgs);

    await f.Mediator.DidNotReceive().Publish(Arg.Any<StreamEventUpdatedNotification>(), Arg.Any<CancellationToken>());
    await f.Mediator.Received(1).Publish(
      Arg.Is<StreamEventOccurredNotification>(n => n.Event.Detail == "resub · Tier 1 · 6 months"), Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task AGiftedSubscribeNeverEntersTheMergeMapAndPublishesNothing()
  {
    var f = Build();
    var giftedSubscribeArgs = SubscribeArgs(userId: "99", userName: "GiftRecipient", tier: "1000", isGift: true);

    await f.Service.OnChannelSubscribeAsync(sender: null, giftedSubscribeArgs);

    await f.Mediator.DidNotReceive().Publish(Arg.Any<StreamEventOccurredNotification>(), Arg.Any<CancellationToken>());

    // A subscription.message for the same user afterward must NOT find a pending merge target.
    var messageArgs = SubscriptionMessageArgs(userId: "99", userName: "GiftRecipient", tier: "1000", cumulativeMonths: 1);
    await f.Service.OnChannelSubscriptionMessageAsync(sender: null, messageArgs);

    await f.Mediator.DidNotReceive().Publish(Arg.Any<StreamEventUpdatedNotification>(), Arg.Any<CancellationToken>());
  }

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

  private static ChannelSubscribeArgs SubscribeArgs(string userId, string userName, string tier, bool isGift = false) => new()
  {
    Payload = new EventSubNotificationPayload<ChannelSubscribe>
    {
      Event = new ChannelSubscribe { UserId = userId, UserName = userName, Tier = tier, IsGift = isGift },
    },
  };

  private static ChannelSubscriptionMessageArgs SubscriptionMessageArgs(string userId, string userName, string tier, int cumulativeMonths) =>
    new()
    {
      Payload = new EventSubNotificationPayload<ChannelSubscriptionMessage>
      {
        Event = new ChannelSubscriptionMessage { UserId = userId, UserName = userName, Tier = tier, CumulativeMonths = cumulativeMonths },
      },
    };
}
