using FluentResults;

using MediatR;

using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;

using Narya.Core.Automation;
using Narya.Core.Chat;
using Narya.Core.Events;
using Narya.Twitch.EventSub;
using Narya.Twitch.EventSub.Notifications;
using Narya.Twitch.Helix;

using TwitchLib.EventSub.Core.EventArgs.Channel;
using TwitchLib.EventSub.Core.Models;
using TwitchLib.EventSub.Core.Models.ChannelPoints;
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
      Arg.Is<ChatMessageIngestedNotification>(n => n.Message.Username == "someviewer"), Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task OnChatMessageAsyncNeverPublishesForTheBotsOwnMessage()
  {
    var f = Build();
    _ = f.HelixClient.GetAuthenticatedUserAsync(TwitchProvider.Bot, Arg.Any<CancellationToken>())
      .Returns(Result.Ok(new HelixUser { Id = "bot-id", Login = "naryabot" }));
    var args = ChatMessageArgs(chatterLogin: "NaryaBot");

    await f.Service.OnChatMessageAsync(sender: null, args);

    await f.Mediator.DidNotReceive().Publish(Arg.Any<ChatMessageIngestedNotification>(), Arg.Any<CancellationToken>());
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

    await f.Mediator.Received(1).Publish(Arg.Any<StreamEventIngestedNotification>(), Arg.Any<CancellationToken>());
    await f.Mediator.Received(1).Publish(
      Arg.Is<StreamEventUpdateIngestedNotification>(n => n.Update.Detail == "resub · Tier 1 · 3 months"), Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task SubscriptionMessageWithNoPrecedingSubscribeEmitsANewStreamEventInstead()
  {
    var f = Build();
    var messageArgs = SubscriptionMessageArgs(userId: "77", userName: "MonthlyResubber", tier: "1000", cumulativeMonths: 6);

    await f.Service.OnChannelSubscriptionMessageAsync(sender: null, messageArgs);

    await f.Mediator.DidNotReceive().Publish(Arg.Any<StreamEventUpdateIngestedNotification>(), Arg.Any<CancellationToken>());
    await f.Mediator.Received(1).Publish(
      Arg.Is<StreamEventIngestedNotification>(n => n.Event.Detail == "resub · Tier 1 · 6 months"), Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task AGiftedSubscribeNeverEntersTheMergeMapAndPublishesNothing()
  {
    var f = Build();
    var giftedSubscribeArgs = SubscribeArgs(userId: "99", userName: "GiftRecipient", tier: "1000", isGift: true);

    await f.Service.OnChannelSubscribeAsync(sender: null, giftedSubscribeArgs);

    await f.Mediator.DidNotReceive().Publish(Arg.Any<StreamEventIngestedNotification>(), Arg.Any<CancellationToken>());

    // A subscription.message for the same user afterward must NOT find a pending merge target.
    var messageArgs = SubscriptionMessageArgs(userId: "99", userName: "GiftRecipient", tier: "1000", cumulativeMonths: 1);
    await f.Service.OnChannelSubscriptionMessageAsync(sender: null, messageArgs);

    await f.Mediator.DidNotReceive().Publish(Arg.Any<StreamEventUpdateIngestedNotification>(), Arg.Any<CancellationToken>());
  }

  /// <summary>
  /// Twitch does NOT guarantee <c>channel.subscribe</c> arrives before
  /// <c>channel.subscription.message</c> — legacy's <c>eventsub.ts</c> handles both orders. This
  /// is the order the pre-fix code got wrong: a <c>channel.subscription.message</c> that lands
  /// FIRST already publishes the full resub stream event, so the <c>channel.subscribe</c> that
  /// follows within the merge window must be skipped rather than publishing a second, duplicate
  /// "new sub" alert for the same subscription.
  /// </summary>
  [Fact]
  public async Task MessageThenSubscribeWithinTheWindowPublishesExactlyOneAlertNotADuplicate()
  {
    var f = Build();
    var messageArgs = SubscriptionMessageArgs(userId: "42", userName: "Resubber", tier: "1000", cumulativeMonths: 3);
    var subscribeArgs = SubscribeArgs(userId: "42", userName: "Resubber", tier: "1000");

    await f.Service.OnChannelSubscriptionMessageAsync(sender: null, messageArgs);
    await f.Service.OnChannelSubscribeAsync(sender: null, subscribeArgs);

    // Exactly one alert total: the resub the message published. The later subscribe must not
    // add a second "new sub" StreamEventIngestedNotification, and must not touch the update
    // notification either.
    await f.Mediator.Received(1).Publish(
      Arg.Is<StreamEventIngestedNotification>(n => n.Event.Detail == "resub · Tier 1 · 3 months"), Arg.Any<CancellationToken>());
    await f.Mediator.DidNotReceive().Publish(Arg.Any<StreamEventUpdateIngestedNotification>(), Arg.Any<CancellationToken>());
  }

  /// <summary>
  /// A redelivered <c>channel.subscription.message</c> for a resub already merged (e.g. an
  /// EventSub reconnect redelivering the same notification) must be dropped outright — not
  /// published as a second <see cref="StreamEventUpdateIngestedNotification"/>.
  /// </summary>
  [Fact]
  public async Task ADuplicateSubscriptionMessageRedeliveryIsDroppedNotPublishedAgain()
  {
    var f = Build();
    var subscribeArgs = SubscribeArgs(userId: "42", userName: "Resubber", tier: "1000");
    var messageArgs = SubscriptionMessageArgs(userId: "42", userName: "Resubber", tier: "1000", cumulativeMonths: 3);

    await f.Service.OnChannelSubscribeAsync(sender: null, subscribeArgs);
    await f.Service.OnChannelSubscriptionMessageAsync(sender: null, messageArgs);
    // The same subscription.message redelivered.
    await f.Service.OnChannelSubscriptionMessageAsync(sender: null, messageArgs);

    await f.Mediator.Received(1).Publish(Arg.Any<StreamEventUpdateIngestedNotification>(), Arg.Any<CancellationToken>());
  }

  // ---------------------------------------------------------------------------------------
  // Automation signals (Phase 4 Task 6) — published ALONGSIDE the stream-event notifications
  // above, never instead of them; see EventSubDispatcher's "Automation signals" region comment
  // for exactly which subscribe/subscription.message branches publish one.
  // ---------------------------------------------------------------------------------------

  [Fact]
  public async Task OnChannelFollowAsyncPublishesTheAutomationSignalAlongsideTheStreamEvent()
  {
    var f = Build();
    var args = new ChannelFollowArgs
    {
      Payload = new EventSubNotificationPayload<ChannelFollow> { Event = new ChannelFollow { UserName = "NewFollower", UserLogin = "newfollower" } },
    };

    await f.Service.OnChannelFollowAsync(sender: null, args);

    await f.Mediator.Received(1).Publish(Arg.Any<StreamEventIngestedNotification>(), Arg.Any<CancellationToken>());
    await f.Mediator.Received(1).Publish(
      Arg.Is<TwitchEventSignalNotification>(n => n.Kind == TwitchAlertEventKind.Follow && n.Actor == "NewFollower"), Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task OnChannelSubscribeAsyncPublishesTheAutomationSignalForAGenuineNewSub()
  {
    var f = Build();
    var args = SubscribeArgs(userId: "1", userName: "NewSubscriber", tier: "1000");

    await f.Service.OnChannelSubscribeAsync(sender: null, args);

    await f.Mediator.Received(1).Publish(
      Arg.Is<TwitchEventSignalNotification>(n => n.Kind == TwitchAlertEventKind.Sub && n.Months == 1), Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task OnChannelSubscribeAsyncNeverPublishesTheAutomationSignalForAGiftedSub()
  {
    var f = Build();
    var args = SubscribeArgs(userId: "2", userName: "GiftRecipient", tier: "1000", isGift: true);

    await f.Service.OnChannelSubscribeAsync(sender: null, args);

    await f.Mediator.DidNotReceive().Publish(Arg.Any<TwitchEventSignalNotification>(), Arg.Any<CancellationToken>());
  }

  /// <summary>A subscribe skipped because a subscription.message already merged must not publish a SECOND automation signal — only the message's fresh-event branch did.</summary>
  [Fact]
  public async Task OnChannelSubscribeAsyncNeverPublishesASecondSignalWhenSkippedForAnAlreadyMergedMessage()
  {
    var f = Build();
    var messageArgs = SubscriptionMessageArgs(userId: "42", userName: "Resubber", tier: "1000", cumulativeMonths: 3);
    var subscribeArgs = SubscribeArgs(userId: "42", userName: "Resubber", tier: "1000");

    await f.Service.OnChannelSubscriptionMessageAsync(sender: null, messageArgs);
    await f.Service.OnChannelSubscribeAsync(sender: null, subscribeArgs);

    await f.Mediator.Received(1).Publish(Arg.Any<TwitchEventSignalNotification>(), Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task OnChannelSubscriptionMessageAsyncPublishesTheAutomationSignalOnlyForAFreshEventNotAMerge()
  {
    var f = Build();
    var subscribeArgs = SubscribeArgs(userId: "42", userName: "Resubber", tier: "1000");
    var messageArgs = SubscriptionMessageArgs(userId: "42", userName: "Resubber", tier: "1000", cumulativeMonths: 3);

    await f.Service.OnChannelSubscribeAsync(sender: null, subscribeArgs);
    await f.Service.OnChannelSubscriptionMessageAsync(sender: null, messageArgs);

    // Exactly one TwitchEventSignalNotification across BOTH calls — the subscribe branch fired
    // it; the merge-update branch must not fire a second one for the same subscription.
    await f.Mediator.Received(1).Publish(Arg.Any<TwitchEventSignalNotification>(), Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task OnChannelSubscriptionMessageAsyncPublishesTheAutomationSignalForAMonthlyResubWithNoPrecedingSubscribe()
  {
    var f = Build();
    var messageArgs = SubscriptionMessageArgs(userId: "77", userName: "MonthlyResubber", tier: "1000", cumulativeMonths: 6);

    await f.Service.OnChannelSubscriptionMessageAsync(sender: null, messageArgs);

    await f.Mediator.Received(1).Publish(
      Arg.Is<TwitchEventSignalNotification>(n => n.Kind == TwitchAlertEventKind.Sub && n.Months == 6), Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task ADuplicateSubscriptionMessageRedeliveryPublishesNoAdditionalAutomationSignal()
  {
    var f = Build();
    var subscribeArgs = SubscribeArgs(userId: "42", userName: "Resubber", tier: "1000");
    var messageArgs = SubscriptionMessageArgs(userId: "42", userName: "Resubber", tier: "1000", cumulativeMonths: 3);

    await f.Service.OnChannelSubscribeAsync(sender: null, subscribeArgs);
    await f.Service.OnChannelSubscriptionMessageAsync(sender: null, messageArgs);
    await f.Service.OnChannelSubscriptionMessageAsync(sender: null, messageArgs);

    await f.Mediator.Received(1).Publish(Arg.Any<TwitchEventSignalNotification>(), Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task OnChannelSubscriptionGiftAsyncPublishesTheAutomationSignalWithTotalAsAmount()
  {
    var f = Build();
    var args = new ChannelSubscriptionGiftArgs
    {
      Payload = new EventSubNotificationPayload<ChannelSubscriptionGift> { Event = new ChannelSubscriptionGift { UserName = "Gifter", UserLogin = "gifter", Total = 5 } },
    };

    await f.Service.OnChannelSubscriptionGiftAsync(sender: null, args);

    await f.Mediator.Received(1).Publish(
      Arg.Is<TwitchEventSignalNotification>(n => n.Kind == TwitchAlertEventKind.Gift && n.Amount == 5), Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task OnChannelCheerAsyncPublishesTheAutomationSignalWithBitsAsAmount()
  {
    var f = Build();
    var args = new ChannelCheerArgs
    {
      Payload = new EventSubNotificationPayload<ChannelCheer> { Event = new ChannelCheer { UserName = "Cheerer", UserLogin = "cheerer", Bits = 500 } },
    };

    await f.Service.OnChannelCheerAsync(sender: null, args);

    await f.Mediator.Received(1).Publish(
      Arg.Is<TwitchEventSignalNotification>(n => n.Kind == TwitchAlertEventKind.Cheer && n.Amount == 500), Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task OnChannelRaidAsyncPublishesTheAutomationSignalWithViewersAsAmount()
  {
    var f = Build();
    var args = new ChannelRaidArgs
    {
      Payload = new EventSubNotificationPayload<ChannelRaid>
      {
        Event = new ChannelRaid { FromBroadcasterUserName = "Raider", FromBroadcasterUserLogin = "raider", Viewers = 12 },
      },
    };

    await f.Service.OnChannelRaidAsync(sender: null, args);

    await f.Mediator.Received(1).Publish(
      Arg.Is<TwitchEventSignalNotification>(n => n.Kind == TwitchAlertEventKind.Raid && n.Amount == 12), Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task OnChannelPointsCustomRewardRedemptionAddAsyncPublishesTheRewardRedeemedSignal()
  {
    var f = Build();
    var args = new ChannelPointsCustomRewardRedemptionArgs
    {
      Payload = new EventSubNotificationPayload<ChannelPointsCustomRewardRedemption>
      {
        Event = new ChannelPointsCustomRewardRedemption
        {
          UserName = "Redeemer",
          UserLogin = "redeemer",
          Reward = new RedemptionReward { Id = "reward-abc", Title = "Play a sound" },
        },
      },
    };

    await f.Service.OnChannelPointsCustomRewardRedemptionAddAsync(sender: null, args);

    await f.Mediator.Received(1).Publish(Arg.Any<StreamEventIngestedNotification>(), Arg.Any<CancellationToken>());
    await f.Mediator.Received(1).Publish(
      Arg.Is<RewardRedeemedSignalNotification>(n => n.RewardId == "reward-abc" && n.RewardTitle == "Play a sound"), Arg.Any<CancellationToken>());
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
