using TwitchLib.EventSub.Core;
using TwitchLib.EventSub.Core.EventArgs.Automod;
using TwitchLib.EventSub.Core.EventArgs.Channel;
using TwitchLib.EventSub.Core.EventArgs.Stream;
using TwitchLib.EventSub.Core.EventArgs.User;

namespace Narya.Twitch.Tests.EventSub;

/// <summary>
/// Step 0's build-time confirmation (Phase 2 Task 5, twitchlib-spec.md §5's UNVERIFIED item):
/// TwitchLib.EventSub.Core 3.0.0 must model a strongly-typed <c>AsyncEventHandler&lt;T&gt;</c>
/// for the EXACT version every entry in <see cref="Narya.Twitch.EventSub.EventSubSubscriptions.All"/>
/// subscribes at — most notably v2 for <c>channel.moderate</c>,
/// <c>automod.message.hold</c>, and <c>automod.message.update</c> (see that class's doc
/// comment for why v2 over v1). There is no runtime behavior to assert: this test passing
/// (i.e. the assignments below compiling at all) IS the proof. A future TwitchLib upgrade that
/// renamed or removed one of these Args types would fail this build immediately, rather than
/// only surfacing once Task 6 tries to wire dispatch against a handler that quietly stopped
/// existing.
/// </summary>
public sealed class EventSubTypedHandlerCompileTests
{
  [Fact]
  public void TypedHandlersForEverySubscribedVersionExistInCore()
  {
    AsyncEventHandler<ChannelModerateV2Args> moderateV2 = (_, _) => Task.CompletedTask;
    AsyncEventHandler<AutomodMessageHoldV2Args> automodHoldV2 = (_, _) => Task.CompletedTask;
    AsyncEventHandler<AutomodMessageUpdateV2Args> automodUpdateV2 = (_, _) => Task.CompletedTask;
    AsyncEventHandler<ChannelFollowArgs> follow = (_, _) => Task.CompletedTask;
    AsyncEventHandler<ChannelChatMessageArgs> chatMessage = (_, _) => Task.CompletedTask;
    AsyncEventHandler<ChannelChatMessageDeleteArgs> chatMessageDelete = (_, _) => Task.CompletedTask;
    AsyncEventHandler<ChannelChatClearArgs> chatClear = (_, _) => Task.CompletedTask;
    AsyncEventHandler<ChannelChatClearUserMessagesArgs> chatClearUserMessages = (_, _) => Task.CompletedTask;
    AsyncEventHandler<ChannelChatNotificationArgs> chatNotification = (_, _) => Task.CompletedTask;
    AsyncEventHandler<ChannelSubscribeArgs> subscribe = (_, _) => Task.CompletedTask;
    AsyncEventHandler<ChannelSubscriptionMessageArgs> subscriptionMessage = (_, _) => Task.CompletedTask;
    AsyncEventHandler<ChannelSubscriptionGiftArgs> subscriptionGift = (_, _) => Task.CompletedTask;
    AsyncEventHandler<ChannelCheerArgs> cheer = (_, _) => Task.CompletedTask;
    AsyncEventHandler<ChannelRaidArgs> raid = (_, _) => Task.CompletedTask;
    AsyncEventHandler<ChannelUpdateArgs> update = (_, _) => Task.CompletedTask;
    AsyncEventHandler<ChannelAdBreakBeginArgs> adBreakBegin = (_, _) => Task.CompletedTask;
    AsyncEventHandler<ChannelPointsCustomRewardRedemptionArgs> redemptionAdd = (_, _) => Task.CompletedTask;
    AsyncEventHandler<StreamOnlineArgs> streamOnline = (_, _) => Task.CompletedTask;
    AsyncEventHandler<StreamOfflineArgs> streamOffline = (_, _) => Task.CompletedTask;
    AsyncEventHandler<UserWhisperMessageArgs> whisper = (_, _) => Task.CompletedTask;

    Assert.NotNull(moderateV2);
    Assert.NotNull(automodHoldV2);
    Assert.NotNull(automodUpdateV2);
    Assert.NotNull(follow);
    Assert.NotNull(chatMessage);
    Assert.NotNull(chatMessageDelete);
    Assert.NotNull(chatClear);
    Assert.NotNull(chatClearUserMessages);
    Assert.NotNull(chatNotification);
    Assert.NotNull(subscribe);
    Assert.NotNull(subscriptionMessage);
    Assert.NotNull(subscriptionGift);
    Assert.NotNull(cheer);
    Assert.NotNull(raid);
    Assert.NotNull(update);
    Assert.NotNull(adBreakBegin);
    Assert.NotNull(redemptionAdd);
    Assert.NotNull(streamOnline);
    Assert.NotNull(streamOffline);
    Assert.NotNull(whisper);
  }
}
