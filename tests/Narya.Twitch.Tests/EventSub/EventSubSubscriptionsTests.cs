using Narya.Twitch.EventSub;

namespace Narya.Twitch.Tests.EventSub;

/// <summary>
/// Regression-locks <see cref="EventSubSubscriptions.All"/> against the exact
/// (type, version, condition-keys) table twitchlib-spec.md §3.4 specifies — in particular the
/// version/condition gotchas call out by name: <c>channel.follow</c> at v2 carrying BOTH
/// <c>broadcaster_user_id</c> and <c>moderator_user_id</c> (not v1's broadcaster-only
/// condition), <c>channel.chat.message</c> carrying <c>broadcaster_user_id</c> +
/// <c>user_id</c>, and <c>channel.raid</c> keying off <c>to_broadcaster_user_id</c> rather than
/// <c>broadcaster_user_id</c>.
/// </summary>
public sealed class EventSubSubscriptionsTests
{
  private const string SampleBroadcasterId = "918273645";

  private static readonly (string Type, string Version, string[] ConditionKeys)[] Expected =
  [
    ("stream.online", "1", ["broadcaster_user_id"]),
    ("stream.offline", "1", ["broadcaster_user_id"]),
    ("channel.update", "2", ["broadcaster_user_id"]),
    ("channel.follow", "2", ["broadcaster_user_id", "moderator_user_id"]),
    ("channel.subscribe", "1", ["broadcaster_user_id"]),
    ("channel.subscription.message", "1", ["broadcaster_user_id"]),
    ("channel.subscription.gift", "1", ["broadcaster_user_id"]),
    ("channel.cheer", "1", ["broadcaster_user_id"]),
    ("channel.raid", "1", ["to_broadcaster_user_id"]),
    ("channel.chat.message", "1", ["broadcaster_user_id", "user_id"]),
    ("channel.chat.message_delete", "1", ["broadcaster_user_id", "user_id"]),
    ("channel.chat.clear", "1", ["broadcaster_user_id", "user_id"]),
    ("channel.chat.clear_user_messages", "1", ["broadcaster_user_id", "user_id"]),
    ("channel.chat.notification", "1", ["broadcaster_user_id", "user_id"]),
    ("channel.moderate", "2", ["broadcaster_user_id", "moderator_user_id"]),
    ("automod.message.hold", "2", ["broadcaster_user_id", "moderator_user_id"]),
    ("automod.message.update", "2", ["broadcaster_user_id", "moderator_user_id"]),
    ("channel.channel_points_custom_reward_redemption.add", "1", ["broadcaster_user_id"]),
    ("channel.ad_break.begin", "1", ["broadcaster_user_id"]),
    ("user.whisper.message", "1", ["user_id"]),
  ];

  [Fact]
  public void AllContainsExactlyTheExpectedSet()
  {
    Assert.Equal(Expected.Length, EventSubSubscriptions.All.Count);

    foreach (var (type, version, keys) in Expected)
    {
      var match = Assert.Single(EventSubSubscriptions.All, s => s.Type == type && s.Version == version);
      var condition = match.ConditionFor(SampleBroadcasterId);
      Assert.Equal(
        keys.OrderBy(k => k, StringComparer.Ordinal),
        condition.Keys.OrderBy(k => k, StringComparer.Ordinal));
    }
  }

  [Fact]
  public void NoDuplicateTypeVersionPairs()
  {
    var pairs = EventSubSubscriptions.All.Select(s => (s.Type, s.Version)).ToArray();
    Assert.Equal(pairs.Length, pairs.Distinct().Count());
  }

  [Fact]
  public void ChannelFollowConditionCarriesBothBroadcasterAndModeratorIds()
  {
    var follow = Assert.Single(EventSubSubscriptions.All, s => s.Type == "channel.follow");
    Assert.Equal("2", follow.Version);

    var condition = follow.ConditionFor(SampleBroadcasterId);

    Assert.Equal(SampleBroadcasterId, condition["broadcaster_user_id"]);
    Assert.Equal(SampleBroadcasterId, condition["moderator_user_id"]);
  }

  [Fact]
  public void ChannelChatMessageConditionCarriesBroadcasterAndUserIds()
  {
    var chatMessage = Assert.Single(EventSubSubscriptions.All, s => s.Type == "channel.chat.message");
    Assert.Equal("1", chatMessage.Version);

    var condition = chatMessage.ConditionFor(SampleBroadcasterId);

    Assert.Equal(SampleBroadcasterId, condition["broadcaster_user_id"]);
    Assert.Equal(SampleBroadcasterId, condition["user_id"]);
  }

  [Fact]
  public void ChannelRaidConditionKeysOffToBroadcasterUserId()
  {
    var raid = Assert.Single(EventSubSubscriptions.All, s => s.Type == "channel.raid");
    Assert.Equal("1", raid.Version);

    var condition = raid.ConditionFor(SampleBroadcasterId);

    var key = Assert.Single(condition.Keys);
    Assert.Equal("to_broadcaster_user_id", key);
    Assert.Equal(SampleBroadcasterId, condition[key]);
  }

  [Fact]
  public void UserWhisperMessageConditionKeysOffUserId()
  {
    var whisper = Assert.Single(EventSubSubscriptions.All, s => s.Type == "user.whisper.message");
    Assert.Equal("1", whisper.Version);

    var condition = whisper.ConditionFor(SampleBroadcasterId);

    var key = Assert.Single(condition.Keys);
    Assert.Equal("user_id", key);
  }

  [Theory]
  [InlineData("channel.moderate")]
  [InlineData("automod.message.hold")]
  [InlineData("automod.message.update")]
  public void ModerationSubscriptionsAreVersion2(string type)
  {
    var subscription = Assert.Single(EventSubSubscriptions.All, s => s.Type == type);

    Assert.Equal("2", subscription.Version);

    var condition = subscription.ConditionFor(SampleBroadcasterId);
    Assert.Equal(SampleBroadcasterId, condition["broadcaster_user_id"]);
    Assert.Equal(SampleBroadcasterId, condition["moderator_user_id"]);
  }
}
