using Narya.Core.Automation;
using Narya.Twitch.EventSub;

using TwitchLib.EventSub.Core.EventArgs.Channel;
using TwitchLib.EventSub.Core.Models;
using TwitchLib.EventSub.Core.Models.ChannelPoints;
using TwitchLib.EventSub.Core.SubscriptionTypes.Channel;
using TwitchLib.EventSub.Websockets.Core.Models;

namespace Narya.Twitch.Tests.EventSub;

/// <summary>
/// The Phase 4 Task 6 additions to <see cref="EventSubDispatcher"/>: the <c>Dispatch*Signal</c>
/// methods and the <c>MessageIdOf</c> event-id resolution they share. Same pure-translation
/// testing style as <see cref="EventSubDispatcherTests"/> — canned <c>*Args</c> POCOs, no socket,
/// no DI, no database.
/// </summary>
public sealed class EventSubDispatcherAutomationSignalTests
{
  [Fact]
  public void DispatchFollowSignalMapsKindActorAndEventId()
  {
    var args = new ChannelFollowArgs
    {
      Metadata = new WebsocketEventSubMetadata { MessageId = "msg-follow-1" },
      Payload = new EventSubNotificationPayload<ChannelFollow>
      {
        Event = new ChannelFollow { UserName = "NewFollower", UserLogin = "newfollower" },
      },
    };

    var signal = EventSubDispatcher.DispatchFollowSignal(args);

    Assert.Equal(TwitchAlertEventKind.Follow, signal.Kind);
    Assert.Equal("msg-follow-1", signal.EventId);
    Assert.Equal("NewFollower", signal.Actor);
    Assert.Equal("newfollower", signal.Login);
    Assert.Null(signal.Amount);
    Assert.Null(signal.Tier);
    Assert.Null(signal.Months);
  }

  [Fact]
  public void DispatchFollowSignalHasANullEventIdWhenMetadataWasNeverSet()
  {
    var args = new ChannelFollowArgs
    {
      Payload = new EventSubNotificationPayload<ChannelFollow> { Event = new ChannelFollow { UserName = "NewFollower" } },
    };

    var signal = EventSubDispatcher.DispatchFollowSignal(args);

    Assert.Null(signal.EventId);
  }

  [Fact]
  public void DispatchSubscribeSignalMapsTierAndFixedOneMonth()
  {
    var args = new ChannelSubscribeArgs
    {
      Metadata = new WebsocketEventSubMetadata { MessageId = "msg-sub-1" },
      Payload = new EventSubNotificationPayload<ChannelSubscribe>
      {
        Event = new ChannelSubscribe { UserName = "NewSubscriber", UserLogin = "newsubscriber", Tier = "2000", IsGift = false },
      },
    };

    var signal = EventSubDispatcher.DispatchSubscribeSignal(args);

    Assert.Equal(TwitchAlertEventKind.Sub, signal.Kind);
    Assert.Equal("msg-sub-1", signal.EventId);
    Assert.Equal("Tier 2", signal.Tier);
    Assert.Equal(1, signal.Months);
    Assert.Null(signal.Amount);
  }

  [Theory]
  [InlineData(0, 1)]
  [InlineData(3, 3)]
  public void DispatchSubscriptionMessageSignalFallsBackToOneMonthWhenCumulativeIsZero(int cumulativeMonths, int expectedMonths)
  {
    var args = new ChannelSubscriptionMessageArgs
    {
      Metadata = new WebsocketEventSubMetadata { MessageId = "msg-resub-1" },
      Payload = new EventSubNotificationPayload<ChannelSubscriptionMessage>
      {
        Event = new ChannelSubscriptionMessage { UserName = "Resubscriber", UserLogin = "resubscriber", Tier = "1000", CumulativeMonths = cumulativeMonths },
      },
    };

    var signal = EventSubDispatcher.DispatchSubscriptionMessageSignal(args);

    Assert.Equal(TwitchAlertEventKind.Sub, signal.Kind);
    Assert.Equal(expectedMonths, signal.Months);
    Assert.Equal("Tier 1", signal.Tier);
  }

  [Fact]
  public void DispatchGiftSignalMapsTotalAsAmountAndFallsBackToAnonymous()
  {
    var named = new ChannelSubscriptionGiftArgs
    {
      Metadata = new WebsocketEventSubMetadata { MessageId = "msg-gift-1" },
      Payload = new EventSubNotificationPayload<ChannelSubscriptionGift>
      {
        Event = new ChannelSubscriptionGift { UserName = "GenerousGifter", UserLogin = "generousgifter", Total = 5 },
      },
    };
    var anonymous = new ChannelSubscriptionGiftArgs
    {
      Payload = new EventSubNotificationPayload<ChannelSubscriptionGift> { Event = new ChannelSubscriptionGift { UserName = null, Total = 2 } },
    };

    var namedSignal = EventSubDispatcher.DispatchGiftSignal(named);
    var anonymousSignal = EventSubDispatcher.DispatchGiftSignal(anonymous);

    Assert.Equal(TwitchAlertEventKind.Gift, namedSignal.Kind);
    Assert.Equal("msg-gift-1", namedSignal.EventId);
    Assert.Equal("GenerousGifter", namedSignal.Actor);
    Assert.Equal(5, namedSignal.Amount);
    Assert.Equal("Anonymous", anonymousSignal.Actor);
    Assert.Equal(2, anonymousSignal.Amount);
  }

  [Fact]
  public void DispatchCheerSignalMapsBitsAsAmount()
  {
    var args = new ChannelCheerArgs
    {
      Metadata = new WebsocketEventSubMetadata { MessageId = "msg-cheer-1" },
      Payload = new EventSubNotificationPayload<ChannelCheer>
      {
        Event = new ChannelCheer { UserName = "BigSpender", UserLogin = "bigspender", Bits = 500 },
      },
    };

    var signal = EventSubDispatcher.DispatchCheerSignal(args);

    Assert.Equal(TwitchAlertEventKind.Cheer, signal.Kind);
    Assert.Equal(500, signal.Amount);
    Assert.Equal("bigspender", signal.Login);
  }

  [Fact]
  public void DispatchRaidSignalMapsViewersAsAmountAndUsesTheFromBroadcaster()
  {
    var args = new ChannelRaidArgs
    {
      Metadata = new WebsocketEventSubMetadata { MessageId = "msg-raid-1" },
      Payload = new EventSubNotificationPayload<ChannelRaid>
      {
        Event = new ChannelRaid { FromBroadcasterUserName = "RaidingStreamer", FromBroadcasterUserLogin = "raidingstreamer", Viewers = 12 },
      },
    };

    var signal = EventSubDispatcher.DispatchRaidSignal(args);

    Assert.Equal(TwitchAlertEventKind.Raid, signal.Kind);
    Assert.Equal("RaidingStreamer", signal.Actor);
    Assert.Equal("raidingstreamer", signal.Login);
    Assert.Equal(12, signal.Amount);
  }

  [Fact]
  public void DispatchRedemptionSignalMapsRewardIdTitleAndTrimmedUserInput()
  {
    var args = new ChannelPointsCustomRewardRedemptionArgs
    {
      Metadata = new WebsocketEventSubMetadata { MessageId = "msg-redeem-1" },
      Payload = new EventSubNotificationPayload<ChannelPointsCustomRewardRedemption>
      {
        Event = new ChannelPointsCustomRewardRedemption
        {
          UserName = "Redeemer",
          UserLogin = "redeemer",
          UserInput = "hello there",
          Reward = new RedemptionReward { Id = "reward-abc-123", Title = "Play a sound" },
        },
      },
    };

    var signal = EventSubDispatcher.DispatchRedemptionSignal(args);

    Assert.Equal("msg-redeem-1", signal.EventId);
    Assert.Equal("reward-abc-123", signal.RewardId);
    Assert.Equal("Play a sound", signal.RewardTitle);
    Assert.Equal("Redeemer", signal.Actor);
    Assert.Equal("redeemer", signal.Login);
    Assert.Equal("hello there", signal.UserInput);
  }

  [Fact]
  public void DispatchRedemptionSignalMapsAnEmptyUserInputToNull()
  {
    var args = new ChannelPointsCustomRewardRedemptionArgs
    {
      Payload = new EventSubNotificationPayload<ChannelPointsCustomRewardRedemption>
      {
        Event = new ChannelPointsCustomRewardRedemption
        {
          UserName = "Redeemer",
          UserInput = string.Empty,
          Reward = new RedemptionReward { Id = "reward-abc-123", Title = "Play a sound" },
        },
      },
    };

    var signal = EventSubDispatcher.DispatchRedemptionSignal(args);

    Assert.Null(signal.UserInput);
  }

  /// <summary>The base <c>EventSubMetadata</c> type carries no properties of its own — only a <see cref="WebsocketEventSubMetadata"/> instance resolves to a message id.</summary>
  [Fact]
  public void MessageIdIsNullWhenMetadataIsSomeOtherEventSubMetadataSubtype()
  {
    var args = new ChannelFollowArgs
    {
      Metadata = new UnknownEventSubMetadata(),
      Payload = new EventSubNotificationPayload<ChannelFollow> { Event = new ChannelFollow { UserName = "NewFollower" } },
    };

    var signal = EventSubDispatcher.DispatchFollowSignal(args);

    Assert.Null(signal.EventId);
  }

  private sealed class UnknownEventSubMetadata : EventSubMetadata;
}
