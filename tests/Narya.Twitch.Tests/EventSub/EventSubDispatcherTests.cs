using Narya.Twitch.Chat;
using Narya.Twitch.EventSub;
using Narya.Twitch.EventSub.Notifications;

using TwitchLib.EventSub.Core.EventArgs.Automod;
using TwitchLib.EventSub.Core.EventArgs.Channel;
using TwitchLib.EventSub.Core.EventArgs.Stream;
using TwitchLib.EventSub.Core.EventArgs.User;
using TwitchLib.EventSub.Core.Models;
using TwitchLib.EventSub.Core.Models.ChannelPoints;
using TwitchLib.EventSub.Core.SubscriptionTypes.Channel;

// TwitchLib.EventSub.Core.Models.Chat.ChatMessage/ChatBadge and
// TwitchLib.EventSub.Core.Models.Whisper.WhisperMessage share their simple names with our own
// domain types (Narya.Core.Chat.ChatMessage — moved here from Narya.Twitch.Chat in Phase 3 — and
// Narya.Twitch.EventSub.Notifications.WhisperMessage) — same collision EventSubDispatcher.cs
// itself documents; aliased here for the same reason.
using TwitchChatBadge = TwitchLib.EventSub.Core.Models.Chat.ChatBadge;
using TwitchChatMessage = TwitchLib.EventSub.Core.Models.Chat.ChatMessage;
using TwitchWhisperMessage = TwitchLib.EventSub.Core.Models.Whisper.WhisperMessage;

namespace Narya.Twitch.Tests.EventSub;

/// <summary>
/// <see cref="EventSubDispatcher"/> is a pure translation (twitchlib-spec.md §3.5/§4): every
/// test here constructs a canned TwitchLib <c>*Args</c> POCO in memory (every property has a
/// public setter — confirmed by Step 0's decompile of TwitchLib.EventSub.Core 3.0.0) and
/// asserts the returned domain notification, with no socket, no DI container, and no database.
/// </summary>
public sealed class EventSubDispatcherTests
{
  private static readonly DateTimeOffset Now = new(2026, 7, 17, 20, 0, 0, TimeSpan.Zero);

  // ---------------------------------------------------------------------------------------
  // Chat message + bot-loop guard + roles
  // ---------------------------------------------------------------------------------------

  [Fact]
  public void DispatchChatMessageMapsEveryFieldAndLowercasesTheLogin()
  {
    var args = new ChannelChatMessageArgs
    {
      Payload = new EventSubNotificationPayload<ChannelChatMessage>
      {
        Event = new ChannelChatMessage
        {
          BroadcasterUserLogin = "codeacula",
          ChatterUserId = "12345",
          ChatterUserLogin = "ViewerOne",
          ChatterUserName = "ViewerOne",
          MessageId = "msg-1",
          Color = "#1E90FF",
          Message = new TwitchChatMessage { Text = "hello chat", Fragments = [] },
          Badges = [new TwitchChatBadge { SetId = "moderator", Id = "1" }],
        },
      },
    };

    var notification = EventSubDispatcher.DispatchChatMessage(args, botLogin: null, Now);

    Assert.NotNull(notification);
    var message = notification!.Message;
    Assert.Equal("msg-1", message.Id);
    Assert.Equal("codeacula", message.Channel);
    Assert.Equal("viewerone", message.Username);
    Assert.Equal("12345", message.ChatterUserId);
    Assert.Equal("ViewerOne", message.DisplayName);
    Assert.Equal("#1E90FF", message.Color);
    Assert.Equal("hello chat", message.Message);
    Assert.Equal(Now, message.ReceivedAt);
    Assert.NotNull(message.Badges);
    Assert.Equal("1", message.Badges!["moderator"]);
    Assert.False(message.IsFirstTimer);
    Assert.False(message.IsFirstThisSession);
    Assert.False(message.IsFirstEver);
    Assert.Null(message.SessionId);
  }

  [Fact]
  public void DispatchChatMessageResolvesTheSameRoleFromBadgesAsFromTheFlagsOverload()
  {
    var args = new ChannelChatMessageArgs
    {
      Payload = new EventSubNotificationPayload<ChannelChatMessage>
      {
        Event = new ChannelChatMessage
        {
          BroadcasterUserLogin = "codeacula",
          ChatterUserLogin = "modviewer",
          ChatterUserName = "ModViewer",
          MessageId = "msg-2",
          Message = new TwitchChatMessage { Text = "hi", Fragments = [] },
          Badges = [new TwitchChatBadge { SetId = "moderator", Id = "1" }],
        },
      },
    };

    var notification = EventSubDispatcher.DispatchChatMessage(args, botLogin: null, Now);

    var roleFromBadges = ChatRoleResolver.ResolveRole(notification!.Message.Badges);
    var roleFromFlags = ChatRoleResolver.ResolveRole(
      args.Payload.Event.IsBroadcaster, args.Payload.Event.IsModerator, args.Payload.Event.IsVip, args.Payload.Event.IsSubscriber);

    Assert.Equal(ChatRole.Moderator, roleFromBadges);
    Assert.Equal(roleFromFlags, roleFromBadges);
  }

  [Fact]
  public void DispatchChatMessageReturnsNullForTheBotsOwnMessage()
  {
    var args = new ChannelChatMessageArgs
    {
      Payload = new EventSubNotificationPayload<ChannelChatMessage>
      {
        Event = new ChannelChatMessage
        {
          BroadcasterUserLogin = "codeacula",
          ChatterUserLogin = "NaryaBot",
          ChatterUserName = "NaryaBot",
          MessageId = "msg-3",
          Message = new TwitchChatMessage { Text = "!tts reply", Fragments = [] },
          Badges = [],
        },
      },
    };

    var notification = EventSubDispatcher.DispatchChatMessage(args, botLogin: "naryabot", Now);

    Assert.Null(notification);
  }

  [Fact]
  public void DispatchChatMessageIsCaseInsensitiveAgainstTheBotLogin()
  {
    var args = new ChannelChatMessageArgs
    {
      Payload = new EventSubNotificationPayload<ChannelChatMessage>
      {
        Event = new ChannelChatMessage
        {
          ChatterUserLogin = "NaryaBot",
          MessageId = "msg-4",
          Message = new TwitchChatMessage { Text = "x", Fragments = [] },
          Badges = [],
        },
      },
    };

    Assert.Null(EventSubDispatcher.DispatchChatMessage(args, botLogin: "NARYABOT", Now));
    Assert.Null(EventSubDispatcher.DispatchChatMessage(args, botLogin: "naryabot", Now));
  }

  [Fact]
  public void DispatchChatMessageDoesNotSkipAnyoneWhenNoBotLoginIsConfigured()
  {
    var args = new ChannelChatMessageArgs
    {
      Payload = new EventSubNotificationPayload<ChannelChatMessage>
      {
        Event = new ChannelChatMessage
        {
          ChatterUserLogin = "someviewer",
          MessageId = "msg-5",
          Message = new TwitchChatMessage { Text = "x", Fragments = [] },
          Badges = [],
        },
      },
    };

    Assert.NotNull(EventSubDispatcher.DispatchChatMessage(args, botLogin: null, Now));
    Assert.NotNull(EventSubDispatcher.DispatchChatMessage(args, botLogin: "", Now));
  }

  [Fact]
  public void DispatchChatMessageMapsAnEmptyColorToNull()
  {
    var args = new ChannelChatMessageArgs
    {
      Payload = new EventSubNotificationPayload<ChannelChatMessage>
      {
        Event = new ChannelChatMessage
        {
          ChatterUserLogin = "someviewer",
          MessageId = "msg-6",
          Color = "",
          Message = new TwitchChatMessage { Text = "x", Fragments = [] },
          Badges = [],
        },
      },
    };

    var notification = EventSubDispatcher.DispatchChatMessage(args, botLogin: null, Now);

    Assert.Null(notification!.Message.Color);
  }

  [Fact]
  public void DispatchChatMessageMapsNoBadgesToNull()
  {
    var args = new ChannelChatMessageArgs
    {
      Payload = new EventSubNotificationPayload<ChannelChatMessage>
      {
        Event = new ChannelChatMessage
        {
          ChatterUserLogin = "someviewer",
          MessageId = "msg-7",
          Message = new TwitchChatMessage { Text = "x", Fragments = [] },
          Badges = [],
        },
      },
    };

    var notification = EventSubDispatcher.DispatchChatMessage(args, botLogin: null, Now);

    Assert.Null(notification!.Message.Badges);
  }

  // ---------------------------------------------------------------------------------------
  // Chat moderation
  // ---------------------------------------------------------------------------------------

  [Fact]
  public void DispatchChatMessageDeleteMapsToMessageDeleted()
  {
    var args = new ChannelChatMessageDeleteArgs
    {
      Payload = new EventSubNotificationPayload<ChannelChatMessageDelete>
      {
        Event = new ChannelChatMessageDelete
        {
          BroadcasterUserLogin = "codeacula",
          TargetUserLogin = "spammer",
          MessageId = "msg-99",
        },
      },
    };

    var notification = EventSubDispatcher.DispatchChatMessageDelete(args, Now);

    Assert.Equal("message.deleted", notification.ModerationEvent.Type);
    Assert.Equal("codeacula", notification.ModerationEvent.Channel);
    Assert.Equal("msg-99", notification.ModerationEvent.MessageId);
    Assert.Equal("spammer", notification.ModerationEvent.Username);
    Assert.Equal(Now, notification.ModerationEvent.DeletedAt);
    Assert.Equal("message deleted by moderator", notification.ModerationEvent.DeletedReason);
  }

  [Fact]
  public void DispatchChatClearMapsToChatClearWithNoMessageOrUsername()
  {
    var args = new ChannelChatClearArgs
    {
      Payload = new EventSubNotificationPayload<ChannelChatClear> { Event = new ChannelChatClear { BroadcasterUserLogin = "codeacula" } },
    };

    var notification = EventSubDispatcher.DispatchChatClear(args, Now);

    Assert.Equal("chat.clear", notification.ModerationEvent.Type);
    Assert.Null(notification.ModerationEvent.MessageId);
    Assert.Null(notification.ModerationEvent.Username);
    Assert.Equal("chat cleared", notification.ModerationEvent.DeletedReason);
  }

  [Fact]
  public void DispatchChatClearUserMessagesMapsToUserTimeout()
  {
    var args = new ChannelChatClearUserMessagesArgs
    {
      Payload = new EventSubNotificationPayload<ChannelChatClearUserMessages>
      {
        Event = new ChannelChatClearUserMessages { BroadcasterUserLogin = "codeacula", TargetUserLogin = "rowdyviewer" },
      },
    };

    var notification = EventSubDispatcher.DispatchChatClearUserMessages(args, Now);

    Assert.Equal("user.timeout", notification.ModerationEvent.Type);
    Assert.Equal("rowdyviewer", notification.ModerationEvent.Username);
    Assert.Null(notification.ModerationEvent.MessageId);
  }

  // ---------------------------------------------------------------------------------------
  // Stream events: follow / sub / gift / cheer / raid / redeem / ad break
  // ---------------------------------------------------------------------------------------

  [Fact]
  public void DispatchFollowMapsToAFollowStreamEvent()
  {
    var args = new ChannelFollowArgs
    {
      Payload = new EventSubNotificationPayload<ChannelFollow>
      {
        Event = new ChannelFollow { UserName = "NewFollower", UserLogin = "newfollower" },
      },
    };

    var notification = EventSubDispatcher.DispatchFollow(args, Now);

    Assert.Equal("follow", notification.Event.Kind);
    Assert.Equal("NewFollower", notification.Event.Actor);
    Assert.Equal("followed", notification.Event.Detail);
    Assert.Equal("silver", notification.Event.Tone);
    Assert.Equal(Now, notification.Event.ReceivedAt);
    Assert.Equal("newfollower", notification.Event.ActorLogin);
    Assert.False(string.IsNullOrEmpty(notification.Event.Id));
  }

  [Theory]
  [InlineData("1000", "Tier 1")]
  [InlineData("2000", "Tier 2")]
  [InlineData("3000", "Tier 3")]
  [InlineData("", "Tier 1")]
  public void DispatchSubscribeMapsTierLabelsExactlyLikeLegacy(string tier, string expectedLabel)
  {
    var args = new ChannelSubscribeArgs
    {
      Payload = new EventSubNotificationPayload<ChannelSubscribe>
      {
        Event = new ChannelSubscribe { UserName = "NewSubscriber", Tier = tier, IsGift = false },
      },
    };

    var notification = EventSubDispatcher.DispatchSubscribe(args, Now);

    Assert.NotNull(notification);
    Assert.Equal("sub", notification!.Event.Kind);
    Assert.Equal($"new sub · {expectedLabel}", notification.Event.Detail);
    Assert.Equal("warning", notification.Event.Tone);
  }

  [Fact]
  public void DispatchSubscribeMapsActorLogin()
  {
    var args = new ChannelSubscribeArgs
    {
      Payload = new EventSubNotificationPayload<ChannelSubscribe>
      {
        Event = new ChannelSubscribe { UserName = "NewSubscriber", UserLogin = "newsubscriber", Tier = "1000", IsGift = false },
      },
    };

    var notification = EventSubDispatcher.DispatchSubscribe(args, Now);

    Assert.NotNull(notification);
    Assert.Equal("newsubscriber", notification!.Event.ActorLogin);
  }

  [Fact]
  public void DispatchSubscribeReturnsNullForAGiftedSub()
  {
    var args = new ChannelSubscribeArgs
    {
      Payload = new EventSubNotificationPayload<ChannelSubscribe> { Event = new ChannelSubscribe { IsGift = true } },
    };

    Assert.Null(EventSubDispatcher.DispatchSubscribe(args, Now));
  }

  [Theory]
  [InlineData(0, "resub · Tier 1")]
  [InlineData(1, "resub · Tier 1 · 1 month")]
  [InlineData(5, "resub · Tier 1 · 5 months")]
  public void DispatchSubscriptionMessageAsNewEventFormatsTheResubDetailExactlyLikeLegacy(int months, string expectedDetail)
  {
    var args = SubscriptionMessageArgs("1000", months);

    var notification = EventSubDispatcher.DispatchSubscriptionMessageAsNewEvent(args, Now);

    Assert.Equal("sub", notification.Event.Kind);
    Assert.Equal(expectedDetail, notification.Event.Detail);
    Assert.Equal("warning", notification.Event.Tone);
    Assert.Equal("resubscriber", notification.Event.ActorLogin);
  }

  [Fact]
  public void DispatchSubscriptionMessageAsMergeUpdatesThePendingStreamEventId()
  {
    var args = SubscriptionMessageArgs("2000", 3);

    var update = EventSubDispatcher.DispatchSubscriptionMessageAsMerge(args, "pending-event-id");

    Assert.Equal("pending-event-id", update.Update.Id);
    Assert.Equal("resub · Tier 2 · 3 months", update.Update.Detail);
    Assert.Equal("warning", update.Update.Tone);
  }

  private static ChannelSubscriptionMessageArgs SubscriptionMessageArgs(string tier, int cumulativeMonths) => new()
  {
    Payload = new EventSubNotificationPayload<ChannelSubscriptionMessage>
    {
      Event = new ChannelSubscriptionMessage
      {
        UserName = "Resubscriber",
        UserLogin = "resubscriber",
        Tier = tier,
        CumulativeMonths = cumulativeMonths,
      },
    },
  };

  [Fact]
  public void ShouldMergeSubscriptionMessageIsTrueWithinTheWindow()
  {
    var subscribedAt = Now;
    var thirtySecondsLater = Now.AddSeconds(30);

    Assert.True(EventSubDispatcher.ShouldMergeSubscriptionMessage(subscribedAt, thirtySecondsLater));
  }

  [Fact]
  public void ShouldMergeSubscriptionMessageIsTrueAtExactlyTheWindowBoundary()
  {
    var subscribedAt = Now;
    var atTheBoundary = Now + EventSubDispatcher.SubscriptionMergeWindow;

    Assert.True(EventSubDispatcher.ShouldMergeSubscriptionMessage(subscribedAt, atTheBoundary));
  }

  [Fact]
  public void ShouldMergeSubscriptionMessageIsFalseOutsideTheWindow()
  {
    var subscribedAt = Now;
    var justOverAMinuteLater = Now + EventSubDispatcher.SubscriptionMergeWindow + TimeSpan.FromSeconds(1);

    Assert.False(EventSubDispatcher.ShouldMergeSubscriptionMessage(subscribedAt, justOverAMinuteLater));
  }

  [Fact]
  public void ShouldSkipSubscribeForPendingMessageIsTrueWhenAMessageAlreadyLandedWithinTheWindow()
  {
    var pending = new TwitchEventSubService.PendingSubscription("event-1", Now, HasMessage: true);

    Assert.True(EventSubDispatcher.ShouldSkipSubscribeForPendingMessage(pending, Now.AddSeconds(30)));
  }

  [Fact]
  public void ShouldSkipSubscribeForPendingMessageIsFalseWhenThePendingEntryIsAPlainSubscribeNotYetMerged()
  {
    var pending = new TwitchEventSubService.PendingSubscription("event-1", Now, HasMessage: false);

    Assert.False(EventSubDispatcher.ShouldSkipSubscribeForPendingMessage(pending, Now.AddSeconds(30)));
  }

  [Fact]
  public void ShouldSkipSubscribeForPendingMessageIsFalseWhenThereIsNoPendingEntry()
  {
    Assert.False(EventSubDispatcher.ShouldSkipSubscribeForPendingMessage(pending: null, Now));
  }

  [Fact]
  public void ShouldSkipSubscribeForPendingMessageIsFalseOutsideTheWindowEvenWithAMessage()
  {
    var pending = new TwitchEventSubService.PendingSubscription("event-1", Now, HasMessage: true);
    var justOverAMinuteLater = Now + EventSubDispatcher.SubscriptionMergeWindow + TimeSpan.FromSeconds(1);

    Assert.False(EventSubDispatcher.ShouldSkipSubscribeForPendingMessage(pending, justOverAMinuteLater));
  }

  [Fact]
  public void DispatchGiftMapsTotalAndPluralization()
  {
    var args = new ChannelSubscriptionGiftArgs
    {
      Payload = new EventSubNotificationPayload<ChannelSubscriptionGift>
      {
        Event = new ChannelSubscriptionGift { UserName = "GenerousGifter", UserLogin = "generousgifter", Total = 5 },
      },
    };

    var notification = EventSubDispatcher.DispatchGift(args, Now);

    Assert.Equal("gift", notification.Event.Kind);
    Assert.Equal("GenerousGifter", notification.Event.Actor);
    Assert.Equal("gifted 5 subs to the channel", notification.Event.Detail);
    Assert.Equal("warning", notification.Event.Tone);
    Assert.Equal("generousgifter", notification.Event.ActorLogin);
  }

  [Fact]
  public void DispatchGiftSingularHasNoTrailingS()
  {
    var args = new ChannelSubscriptionGiftArgs
    {
      Payload = new EventSubNotificationPayload<ChannelSubscriptionGift> { Event = new ChannelSubscriptionGift { UserName = "Gifter", Total = 1 } },
    };

    var notification = EventSubDispatcher.DispatchGift(args, Now);

    Assert.Equal("gifted 1 sub to the channel", notification.Event.Detail);
  }

  [Fact]
  public void DispatchGiftFallsBackToAnonymousWhenUserNameIsMissing()
  {
    var args = new ChannelSubscriptionGiftArgs
    {
      Payload = new EventSubNotificationPayload<ChannelSubscriptionGift> { Event = new ChannelSubscriptionGift { UserName = null, Total = 2 } },
    };

    var notification = EventSubDispatcher.DispatchGift(args, Now);

    Assert.Equal("Anonymous", notification.Event.Actor);
  }

  [Fact]
  public void DispatchCheerMapsBitsAndFallsBackToAnonymous()
  {
    var namedArgs = new ChannelCheerArgs
    {
      Payload = new EventSubNotificationPayload<ChannelCheer>
      {
        Event = new ChannelCheer { UserName = "BigSpender", UserLogin = "bigspender", Bits = 500 },
      },
    };
    var anonymousArgs = new ChannelCheerArgs
    {
      Payload = new EventSubNotificationPayload<ChannelCheer> { Event = new ChannelCheer { UserName = null, Bits = 100 } },
    };

    var named = EventSubDispatcher.DispatchCheer(namedArgs, Now);
    var anonymous = EventSubDispatcher.DispatchCheer(anonymousArgs, Now);

    Assert.Equal("cheer", named.Event.Kind);
    Assert.Equal("BigSpender", named.Event.Actor);
    Assert.Equal("cheered 500 bits", named.Event.Detail);
    Assert.Equal("info", named.Event.Tone);
    Assert.Equal("bigspender", named.Event.ActorLogin);
    Assert.Equal("Anonymous", anonymous.Event.Actor);
  }

  [Fact]
  public void DispatchRaidMapsViewerCountAndPluralization()
  {
    var args = new ChannelRaidArgs
    {
      Payload = new EventSubNotificationPayload<ChannelRaid>
      {
        Event = new ChannelRaid { FromBroadcasterUserName = "RaidingStreamer", FromBroadcasterUserLogin = "raidingstreamer", Viewers = 12 },
      },
    };

    var notification = EventSubDispatcher.DispatchRaid(args, Now);

    Assert.Equal("raid", notification.Event.Kind);
    Assert.Equal("RaidingStreamer", notification.Event.Actor);
    Assert.Equal("raided with 12 viewers", notification.Event.Detail);
    Assert.Equal("note", notification.Event.Tone);
    Assert.Equal("raidingstreamer", notification.Event.ActorLogin);
  }

  [Fact]
  public void DispatchRedemptionUsesTheTwitchRedemptionIdAsTheStreamEventId()
  {
    var args = new ChannelPointsCustomRewardRedemptionArgs
    {
      Payload = new EventSubNotificationPayload<ChannelPointsCustomRewardRedemption>
      {
        Event = new ChannelPointsCustomRewardRedemption
        {
          Id = "redemption-abc-123",
          UserName = "Redeemer",
          UserLogin = "redeemer",
          Reward = new RedemptionReward { Title = "Play a sound" },
        },
      },
    };

    var notification = EventSubDispatcher.DispatchRedemption(args, Now);

    Assert.Equal("redemption-abc-123", notification.Event.Id);
    Assert.Equal("redeem", notification.Event.Kind);
    Assert.Equal("redeemed \"Play a sound\"", notification.Event.Detail);
    Assert.Equal("info", notification.Event.Tone);
    Assert.Equal("redeemer", notification.Event.ActorLogin);
  }

  [Fact]
  public void DispatchAdBreakMapsDurationAndActor()
  {
    var args = new ChannelAdBreakBeginArgs
    {
      Payload = new EventSubNotificationPayload<ChannelAdBreakBegin> { Event = new ChannelAdBreakBegin { DurationSeconds = 90 } },
    };

    var notification = EventSubDispatcher.DispatchAdBreak(args, Now);

    Assert.Equal("ad_break", notification.Event.Kind);
    Assert.Equal("Twitch", notification.Event.Actor);
    Assert.Equal("ad break · 90s", notification.Event.Detail);
    Assert.Equal("info", notification.Event.Tone);
    Assert.Null(notification.Event.ActorLogin); // no login source for an ad break — matches legacy's unparameterized emitStreamEvent call
  }

  // ---------------------------------------------------------------------------------------
  // Chat notification (watch streak) — Phase 2 final-review fix pass
  // ---------------------------------------------------------------------------------------

  [Fact]
  public void DispatchChatNotificationMapsAWatchStreakToARedeemStreamEvent()
  {
    var args = ChatNotificationArgs("watch_streak", "LoyalViewer");

    var notification = EventSubDispatcher.DispatchChatNotification(args, Now);

    Assert.NotNull(notification);
    Assert.Equal("redeem", notification!.Event.Kind);
    Assert.Equal("LoyalViewer", notification.Event.Actor);
    Assert.Equal("watch streak", notification.Event.Detail);
    Assert.Equal("silver", notification.Event.Tone);
    Assert.Equal(Now, notification.Event.ReceivedAt);
    Assert.False(string.IsNullOrEmpty(notification.Event.Id));
    Assert.Equal("loyalviewer", notification.Event.ActorLogin);
  }

  [Theory]
  [InlineData("sub")]
  [InlineData("resub")]
  [InlineData("raid")]
  [InlineData("announcement")]
  public void DispatchChatNotificationReturnsNullForEveryNonWatchStreakNoticeType(string noticeType)
  {
    var args = ChatNotificationArgs(noticeType, "SomeChatter");

    Assert.Null(EventSubDispatcher.DispatchChatNotification(args, Now));
  }

  private static ChannelChatNotificationArgs ChatNotificationArgs(string noticeType, string chatterUserName) => new()
  {
    Payload = new EventSubNotificationPayload<ChannelChatNotification>
    {
      Event = new ChannelChatNotification
      {
        BroadcasterUserLogin = "codeacula",
        ChatterUserName = chatterUserName,
        ChatterUserLogin = chatterUserName.ToLowerInvariant(),
        NoticeType = noticeType,
      },
    },
  };

  // ---------------------------------------------------------------------------------------
  // Whisper
  // ---------------------------------------------------------------------------------------

  [Fact]
  public void DispatchWhisperMapsEveryField()
  {
    var args = new UserWhisperMessageArgs
    {
      Payload = new EventSubNotificationPayload<TwitchLib.EventSub.Core.SubscriptionTypes.User.UserWhisperMessage>
      {
        Event = new TwitchLib.EventSub.Core.SubscriptionTypes.User.UserWhisperMessage
        {
          WhisperId = "whisper-1",
          FromUserLogin = "whisperer",
          FromUserName = "Whisperer",
          Whisper = new TwitchWhisperMessage { Text = "psst" },
        },
      },
    };

    var notification = EventSubDispatcher.DispatchWhisper(args, Now);

    Assert.Equal("whisper-1", notification.Whisper.Id);
    Assert.Equal("whisperer", notification.Whisper.FromLogin);
    Assert.Equal("Whisperer", notification.Whisper.FromDisplayName);
    Assert.Equal("psst", notification.Whisper.Text);
    Assert.Equal(Now, notification.Whisper.ReceivedAt);
  }

  [Fact]
  public void DispatchWhisperFallsBackToLoginForDisplayNameWhenNameIsMissing()
  {
    var args = new UserWhisperMessageArgs
    {
      Payload = new EventSubNotificationPayload<TwitchLib.EventSub.Core.SubscriptionTypes.User.UserWhisperMessage>
      {
        Event = new TwitchLib.EventSub.Core.SubscriptionTypes.User.UserWhisperMessage
        {
          WhisperId = "whisper-2",
          FromUserLogin = "whisperer",
          FromUserName = "",
          Whisper = new TwitchWhisperMessage { Text = "hi" },
        },
      },
    };

    var notification = EventSubDispatcher.DispatchWhisper(args, Now);

    Assert.Equal("whisperer", notification.Whisper.FromDisplayName);
  }

  // ---------------------------------------------------------------------------------------
  // Deferred-phase scaffolding: channel.update / stream online-offline / automod
  // ---------------------------------------------------------------------------------------

  [Fact]
  public void DispatchChannelUpdateMapsCategoryIdAndName()
  {
    var args = new ChannelUpdateArgs
    {
      Payload = new EventSubNotificationPayload<ChannelUpdate>
      {
        Event = new ChannelUpdate { CategoryId = "509658", CategoryName = "Just Chatting" },
      },
    };

    var notification = EventSubDispatcher.DispatchChannelUpdate(args);

    Assert.Equal("509658", notification.GameId);
    Assert.Equal("Just Chatting", notification.GameName);
  }

  [Fact]
  public void DispatchChannelUpdateNormalizesAnEmptyCategoryToNull()
  {
    var args = new ChannelUpdateArgs
    {
      Payload = new EventSubNotificationPayload<ChannelUpdate> { Event = new ChannelUpdate { CategoryId = "", CategoryName = "" } },
    };

    var notification = EventSubDispatcher.DispatchChannelUpdate(args);

    Assert.Null(notification.GameId);
    Assert.Null(notification.GameName);
  }

  [Fact]
  public void DispatchStreamOnlineMapsIdAndStartedAt()
  {
    var startedAt = Now;
    var args = new StreamOnlineArgs
    {
      Payload = new EventSubNotificationPayload<TwitchLib.EventSub.Core.SubscriptionTypes.Stream.StreamOnline>
      {
        Event = new TwitchLib.EventSub.Core.SubscriptionTypes.Stream.StreamOnline { Id = "stream-1", StartedAt = startedAt },
      },
    };

    var notification = EventSubDispatcher.DispatchStreamOnline(args);

    Assert.Equal("stream-1", notification.StreamId);
    Assert.Equal(startedAt, notification.StartedAt);
  }

  [Fact]
  public void DispatchStreamOfflineProducesTheNotification()
  {
    var args = new StreamOfflineArgs
    {
      Payload = new EventSubNotificationPayload<TwitchLib.EventSub.Core.SubscriptionTypes.Stream.StreamOffline>
      {
        Event = new TwitchLib.EventSub.Core.SubscriptionTypes.Stream.StreamOffline(),
      },
    };

    var notification = EventSubDispatcher.DispatchStreamOffline(args);

    Assert.NotNull(notification);
  }

  [Fact]
  public void DispatchAutomodHoldMapsEveryField()
  {
    var heldAt = Now;
    var args = new AutomodMessageHoldV2Args
    {
      Payload = new EventSubNotificationPayload<TwitchLib.EventSub.Core.SubscriptionTypes.Automod.AutomodMessageHoldV2>
      {
        Event = new TwitchLib.EventSub.Core.SubscriptionTypes.Automod.AutomodMessageHoldV2
        {
          MessageId = "held-1",
          UserLogin = "riskyviewer",
          UserName = "RiskyViewer",
          Message = new TwitchLib.EventSub.Core.Models.Automod.Message { Text = "questionable text" },
          Reason = "automod",
          HeldAt = heldAt,
        },
      },
    };

    var notification = EventSubDispatcher.DispatchAutomodHold(args);

    Assert.Equal("held-1", notification.MessageId);
    Assert.Equal("riskyviewer", notification.Username);
    Assert.Equal("RiskyViewer", notification.DisplayName);
    Assert.Equal("questionable text", notification.Message);
    Assert.Equal("automod", notification.Reason);
    Assert.Equal(heldAt, notification.HeldAt);
  }

  [Fact]
  public void DispatchAutomodUpdateMapsEveryField()
  {
    var args = new AutomodMessageUpdateV2Args
    {
      Payload = new EventSubNotificationPayload<TwitchLib.EventSub.Core.SubscriptionTypes.Automod.AutomodMessageUpdateV2>
      {
        Event = new TwitchLib.EventSub.Core.SubscriptionTypes.Automod.AutomodMessageUpdateV2
        {
          MessageId = "held-1",
          Status = "Approved",
          ModeratorUserName = "ModeratorName",
        },
      },
    };

    var notification = EventSubDispatcher.DispatchAutomodUpdate(args);

    Assert.Equal("held-1", notification.MessageId);
    Assert.Equal("Approved", notification.Status);
    Assert.Equal("ModeratorName", notification.ModeratorUserName);
  }
}
