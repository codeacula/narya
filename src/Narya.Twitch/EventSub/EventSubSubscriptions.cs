namespace Narya.Twitch.EventSub;

/// <summary>
/// One row of the type+version+condition table <see cref="TwitchEventSubService"/> replays
/// against Helix every time it needs to (re)create every EventSub subscription: on first
/// connect, and after a hard-drop reconnect that produced a new session id (see
/// <see cref="TwitchEventSubService.ShouldResubscribe"/>). <see cref="ConditionFor"/> takes
/// the resolved broadcaster user id and builds the exact condition dictionary Twitch expects
/// for this subscription type — the condition KEYS vary by type (twitchlib-spec.md §3.4: e.g.
/// <c>channel.raid</c> keys off <c>to_broadcaster_user_id</c>, not <c>broadcaster_user_id</c>),
/// so this is a function of the broadcaster id rather than a fixed dictionary.
/// </summary>
public sealed record EventSubSubscription
{
  public required string Type { get; init; }

  public required string Version { get; init; }

  public required Func<string, Dictionary<string, string>> ConditionFor { get; init; }
}

/// <summary>
/// The full set of EventSub subscriptions Narya creates over the broadcaster's websocket
/// session (twitchlib-spec.md §3.4). Every condition below resolves entirely from the
/// broadcaster's own user id — Narya has no moderator-bot identity distinct from the
/// broadcaster and bot accounts already modeled by <see cref="TwitchProvider"/>, so anywhere
/// Twitch's condition schema calls for <c>moderator_user_id</c> or <c>user_id</c> (chat,
/// <c>automod.message.*</c>, <c>channel.follow</c>, <c>user.whisper.message</c>), it is filled
/// with the broadcaster id too — matching legacy.
///
/// Both <c>automod.message.*</c> types are subscribed at <b>v2</b>, not v1: Step 0 (Phase 2
/// Task 5, twitchlib-spec.md §5 UNVERIFIED item) confirmed TwitchLib.EventSub.Core 3.0.0
/// models typed handlers for both versions of each
/// (<c>AutomodMessageHoldArgs</c>/<c>AutomodMessageHoldV2Args</c>,
/// <c>AutomodMessageUpdateArgs</c>/<c>AutomodMessageUpdateV2Args</c>) — v2 was chosen because
/// it is a strict superset, and because <see cref="TwitchLib.EventSub.Websockets.EventSubWebsocketClient"/>
/// keys its dispatch off the <c>(type, version)</c> pair Twitch echoes back in each
/// notification's metadata — subscribing at v2 is what makes the client route into the
/// V2-typed handler rather than the deprecated v1 one. See the Phase 2 Task 5 report for the
/// full Step 0 findings.
///
/// <c>channel.moderate</c> is deliberately ABSENT — see the comment at its former place below.
/// </summary>
public static class EventSubSubscriptions
{
  public static readonly IReadOnlyList<EventSubSubscription> All =
  [
    new() { Type = "stream.online", Version = "1", ConditionFor = Broadcaster },
    new() { Type = "stream.offline", Version = "1", ConditionFor = Broadcaster },
    new() { Type = "channel.update", Version = "2", ConditionFor = Broadcaster },
    new() { Type = "channel.follow", Version = "2", ConditionFor = BroadcasterAndModerator },
    new() { Type = "channel.subscribe", Version = "1", ConditionFor = Broadcaster },
    new() { Type = "channel.subscription.message", Version = "1", ConditionFor = Broadcaster },
    new() { Type = "channel.subscription.gift", Version = "1", ConditionFor = Broadcaster },
    new() { Type = "channel.cheer", Version = "1", ConditionFor = Broadcaster },
    new() { Type = "channel.raid", Version = "1", ConditionFor = ToBroadcaster },
    new() { Type = "channel.chat.message", Version = "1", ConditionFor = BroadcasterAndUser },
    new() { Type = "channel.chat.message_delete", Version = "1", ConditionFor = BroadcasterAndUser },
    new() { Type = "channel.chat.clear", Version = "1", ConditionFor = BroadcasterAndUser },
    new() { Type = "channel.chat.clear_user_messages", Version = "1", ConditionFor = BroadcasterAndUser },
    new() { Type = "channel.chat.notification", Version = "1", ConditionFor = BroadcasterAndUser },

    // channel.moderate v2 (richer ban/timeout-with-reason + moderator name) is DEFERRED to
    // Phase 3 — it needs broad moderator:read/manage scopes (blocked_terms, chat_settings,
    // unban_requests, banned_users, chat_messages, warnings, moderators, vips) not in
    // Scopes.Broadcaster; adding them expands the operator's OAuth consent, so it's the
    // operator's call when moderation persistence lands. Subscribing anyway 403s at creation
    // (twitchlib-spec.md documented it as inherited verbatim from legacy, which never actually
    // subscribed to channel.moderate — legacy's ban/timeout signal was tmi.js `timeout`/`ban`
    // events, not EventSub). The visible signal today is channel.chat.clear_user_messages
    // (below) — DispatchChatClearUserMessages's doc comment covers what that does and does not
    // carry compared to what v2 would have added.
    new() { Type = "automod.message.hold", Version = "2", ConditionFor = BroadcasterAndModerator },
    new() { Type = "automod.message.update", Version = "2", ConditionFor = BroadcasterAndModerator },
    new() { Type = "channel.channel_points_custom_reward_redemption.add", Version = "1", ConditionFor = Broadcaster },
    new() { Type = "channel.ad_break.begin", Version = "1", ConditionFor = Broadcaster },
    new() { Type = "user.whisper.message", Version = "1", ConditionFor = User },
  ];

  private static Dictionary<string, string> Broadcaster(string broadcasterId) =>
    new() { ["broadcaster_user_id"] = broadcasterId };

  private static Dictionary<string, string> ToBroadcaster(string broadcasterId) =>
    new() { ["to_broadcaster_user_id"] = broadcasterId };

  private static Dictionary<string, string> User(string broadcasterId) =>
    new() { ["user_id"] = broadcasterId };

  private static Dictionary<string, string> BroadcasterAndModerator(string broadcasterId) =>
    new() { ["broadcaster_user_id"] = broadcasterId, ["moderator_user_id"] = broadcasterId };

  private static Dictionary<string, string> BroadcasterAndUser(string broadcasterId) =>
    new() { ["broadcaster_user_id"] = broadcasterId, ["user_id"] = broadcasterId };
}
