using Narya.Twitch.Chat;
using Narya.Twitch.EventSub.Notifications;

using TwitchLib.EventSub.Core.EventArgs.Automod;
using TwitchLib.EventSub.Core.EventArgs.Channel;
using TwitchLib.EventSub.Core.EventArgs.Stream;
using TwitchLib.EventSub.Core.EventArgs.User;

// TwitchLib.EventSub.Core.Models.Chat.ChatMessage/ChatBadge share their simple names with our
// own Narya.Twitch.Chat.ChatMessage and would collide under a plain `using` — the same
// EventSubSubscription collision Phase 2 Task 5 already worked around (see that task's report).
// Every other TwitchLib model this file touches (WhisperMessage, RedemptionReward, Ban,
// Timeout, Delete, Message, AutomodData, SubscriptionMessage, ...) is reached purely through
// property-chain access (`e.Reward.Title`, `e.Ban.UserLogin`, ...) with the type name never
// spelled out, so only ChatBadge needs an alias.
using TwitchChatBadge = TwitchLib.EventSub.Core.Models.Chat.ChatBadge;

namespace Narya.Twitch.EventSub;

/// <summary>
/// Translates a TwitchLib EventSub notification (the strongly-typed <c>*Args</c> payload
/// TwitchLib.EventSub.Websockets hands to each event handler) into the domain notification
/// Narya's application layer understands, and nothing else — twitchlib-spec.md §3.5/§4: "the
/// dispatcher is a PURE function ... NO I/O", specifically so it is testable by constructing a
/// canned <c>*Args</c> POCO in memory and asserting the returned notification, with no socket,
/// no DI container, and no database. Every method here is a static, side-effect-free
/// translation; <see cref="TwitchEventSubService"/> is what actually publishes the result and
/// owns the one piece of state a pure function cannot (the subscribe/subscription.message
/// merge window — see <see cref="ShouldMergeSubscriptionMessage"/>'s doc comment).
///
/// Detail-string and tone conventions (e.g. <c>"new sub · Tier 2"</c>, <c>"raided with 12
/// viewers"</c>) are copied verbatim from legacy's <c>legacy/src/server/eventsub.ts</c>, which
/// already ran EventSub for these exact subscription types (only chat ingestion is new to
/// EventSub in Narya — legacy chatted over tmi.js).
/// </summary>
public static class EventSubDispatcher
{
  /// <summary>
  /// How long after a <c>channel.subscribe</c> a <c>channel.subscription.message</c> for the
  /// same user is treated as the second half of the same resub notification, rather than an
  /// unrelated one — copied from legacy's <c>SUB_MERGE_WINDOW_MS</c>.
  /// </summary>
  public static readonly TimeSpan SubscriptionMergeWindow = TimeSpan.FromSeconds(60);

  /// <summary>
  /// The merge decision <see cref="TwitchEventSubService"/> consults after finding a pending
  /// subscribe for this chatter in its own in-memory map (necessarily stateful — a pure
  /// function has nowhere to remember "did I already see a subscribe for this user" between
  /// calls). Given the pending entry's timestamp, this is what actually decides "in window or
  /// not", kept pure and separately testable from the stateful lookup around it.
  /// </summary>
  public static bool ShouldMergeSubscriptionMessage(DateTimeOffset pendingSubscribedAt, DateTimeOffset now) =>
    now >= pendingSubscribedAt && now - pendingSubscribedAt <= SubscriptionMergeWindow;

  /// <summary>
  /// Bot-loop guard: a message whose <c>chatter_user_login</c> matches
  /// <paramref name="botLogin"/> (case-insensitive; comparison skipped entirely when
  /// <paramref name="botLogin"/> is null/empty, i.e. no bot account configured) returns null —
  /// the bot's own chat messages (e.g. <c>!tts</c> replies) must never re-enter chat ingestion.
  /// <paramref name="now"/> is supplied by the caller rather than read from a clock in here,
  /// keeping this method a pure function of its inputs.
  /// </summary>
  public static ChatMessageReceivedNotification? DispatchChatMessage(
    ChannelChatMessageArgs args, string? botLogin, DateTimeOffset now)
  {
    var e = args.Payload.Event;
    var login = (e.ChatterUserLogin ?? string.Empty).ToLowerInvariant();

    if (!string.IsNullOrEmpty(botLogin) && string.Equals(login, botLogin, StringComparison.OrdinalIgnoreCase))
    {
      return null;
    }

    var message = new ChatMessage(
      Id: e.MessageId,
      Channel: e.BroadcasterUserLogin,
      Username: login,
      DisplayName: e.ChatterUserName,
      Color: string.IsNullOrEmpty(e.Color) ? null : e.Color,
      Message: e.Message.Text,
      ReceivedAt: now,
      Badges: ToBadgeDictionary(e.Badges));

    return new ChatMessageReceivedNotification(message);
  }

  public static ChatModeratedNotification DispatchChatMessageDelete(ChannelChatMessageDeleteArgs args, DateTimeOffset now)
  {
    var e = args.Payload.Event;
    var moderationEvent = new ChatModerationEvent(
      "message.deleted", e.BroadcasterUserLogin, e.MessageId, e.TargetUserLogin, now, "message deleted by moderator");
    return new ChatModeratedNotification(moderationEvent);
  }

  public static ChatModeratedNotification DispatchChatClear(ChannelChatClearArgs args, DateTimeOffset now)
  {
    var e = args.Payload.Event;
    var moderationEvent = new ChatModerationEvent(
      "chat.clear", e.BroadcasterUserLogin, MessageId: null, Username: null, now, "chat cleared");
    return new ChatModeratedNotification(moderationEvent);
  }

  /// <summary>
  /// Twitch fires this for a bulk per-user clear (ban or timeout both trigger it) without a
  /// reason — <c>channel.moderate</c> v2 (<see cref="DispatchModerate"/>) is the richer source
  /// that carries the actual reason for the same underlying action. Both are dispatched
  /// independently (twitchlib-spec.md §3.5 lists them as separate mappings); a consumer that
  /// persists both is expected to dedup on (channel, username, a tight time window) — noted as
  /// a Phase 3 follow-up in the Task 6 report, not solved here.
  /// </summary>
  public static ChatModeratedNotification DispatchChatClearUserMessages(ChannelChatClearUserMessagesArgs args, DateTimeOffset now)
  {
    var e = args.Payload.Event;
    var moderationEvent = new ChatModerationEvent(
      "user.timeout", e.BroadcasterUserLogin, MessageId: null, e.TargetUserLogin, now, "messages cleared");
    return new ChatModeratedNotification(moderationEvent);
  }

  /// <summary>
  /// <c>channel.moderate</c> v2 covers far more action types than chat moderation (VIP grants,
  /// slow mode, raids, ...) — only <c>ban</c>, <c>timeout</c>, and <c>delete</c> produce a
  /// <see cref="ChatModerationEvent"/>; every other action returns null (nothing to persist as
  /// a moderated chat message).
  /// </summary>
  public static ChatModeratedNotification? DispatchModerate(ChannelModerateV2Args args, DateTimeOffset now)
  {
    var e = args.Payload.Event;

    ChatModerationEvent? moderationEvent = (e.Action, e.Ban, e.Timeout, e.Delete) switch
    {
      ("ban", { } ban, _, _) => new ChatModerationEvent(
        "user.ban", e.BroadcasterUserLogin, MessageId: null, ban.UserLogin, now, $"ban: {ReasonOrDefault(ban.Reason)}"),

      ("timeout", _, { } timeout, _) => new ChatModerationEvent(
        "user.timeout", e.BroadcasterUserLogin, MessageId: null, timeout.UserLogin, now,
        $"timeout: {ReasonOrDefault(timeout.Reason)}"),

      ("delete", _, _, { } delete) => new ChatModerationEvent(
        "message.deleted", e.BroadcasterUserLogin, delete.MessageId, delete.UserLogin, now,
        "message deleted by moderator"),

      _ => null,
    };

    return moderationEvent is null ? null : new ChatModeratedNotification(moderationEvent);
  }

  public static StreamEventOccurredNotification DispatchFollow(ChannelFollowArgs args, DateTimeOffset now)
  {
    var e = args.Payload.Event;
    var streamEvent = new StreamEvent(Guid.NewGuid().ToString(), "follow", e.UserName, "followed", "silver", now);
    return new StreamEventOccurredNotification(streamEvent);
  }

  /// <summary>
  /// Null when <c>is_gift</c> is set — a gifted sub's "who received it" notification is
  /// <c>channel.subscription.gift</c> (<see cref="DispatchGift"/>), not this one; Twitch still
  /// fires <c>channel.subscribe</c> for each recipient, and surfacing both would double-count
  /// the sub as two stream events. Matches legacy's <c>if (event.is_gift) break;</c>.
  /// </summary>
  public static StreamEventOccurredNotification? DispatchSubscribe(ChannelSubscribeArgs args, DateTimeOffset now)
  {
    var e = args.Payload.Event;
    if (e.IsGift)
    {
      return null;
    }

    var detail = $"new sub · {TierLabel(e.Tier)}";
    var streamEvent = new StreamEvent(Guid.NewGuid().ToString(), "sub", e.UserName, detail, "warning", now);
    return new StreamEventOccurredNotification(streamEvent);
  }

  /// <summary>
  /// The "no pending subscribe to merge into" path: either a monthly resub (Twitch never fires
  /// <c>channel.subscribe</c> for those, only this) or the merge window already lapsed. Builds
  /// a brand-new <see cref="StreamEvent"/> with the full resub detail
  /// (<see cref="ResubDetail"/>) rather than the bare "new sub" wording.
  /// </summary>
  public static StreamEventOccurredNotification DispatchSubscriptionMessageAsNewEvent(
    ChannelSubscriptionMessageArgs args, DateTimeOffset now)
  {
    var e = args.Payload.Event;
    var streamEvent = new StreamEvent(
      Guid.NewGuid().ToString(), "sub", e.UserName, ResubDetail(e.Tier, e.CumulativeMonths), "warning", now);
    return new StreamEventOccurredNotification(streamEvent);
  }

  /// <summary>
  /// The merge path: updates the <see cref="StreamEvent"/> a preceding <c>channel.subscribe</c>
  /// already emitted (<paramref name="pendingStreamEventId"/>) with the richer resub detail,
  /// instead of emitting a second stream event for the same subscription.
  /// </summary>
  public static StreamEventUpdatedNotification DispatchSubscriptionMessageAsMerge(
    ChannelSubscriptionMessageArgs args, string pendingStreamEventId)
  {
    var e = args.Payload.Event;
    var update = new StreamEventUpdate(pendingStreamEventId, ResubDetail(e.Tier, e.CumulativeMonths), "warning");
    return new StreamEventUpdatedNotification(update);
  }

  public static StreamEventOccurredNotification DispatchGift(ChannelSubscriptionGiftArgs args, DateTimeOffset now)
  {
    var e = args.Payload.Event;
    var gifter = string.IsNullOrEmpty(e.UserName) ? "Anonymous" : e.UserName;
    var detail = $"gifted {e.Total} sub{(e.Total != 1 ? "s" : "")} to the channel";
    var streamEvent = new StreamEvent(Guid.NewGuid().ToString(), "gift", gifter, detail, "warning", now);
    return new StreamEventOccurredNotification(streamEvent);
  }

  public static StreamEventOccurredNotification DispatchCheer(ChannelCheerArgs args, DateTimeOffset now)
  {
    var e = args.Payload.Event;
    var cheerer = string.IsNullOrEmpty(e.UserName) ? "Anonymous" : e.UserName;
    var detail = $"cheered {e.Bits} bits";
    var streamEvent = new StreamEvent(Guid.NewGuid().ToString(), "cheer", cheerer, detail, "info", now);
    return new StreamEventOccurredNotification(streamEvent);
  }

  public static StreamEventOccurredNotification DispatchRaid(ChannelRaidArgs args, DateTimeOffset now)
  {
    var e = args.Payload.Event;
    var detail = $"raided with {e.Viewers} viewer{(e.Viewers != 1 ? "s" : "")}";
    var streamEvent = new StreamEvent(Guid.NewGuid().ToString(), "raid", e.FromBroadcasterUserName, detail, "note", now);
    return new StreamEventOccurredNotification(streamEvent);
  }

  /// <summary><see cref="StreamEvent.Id"/> is the Twitch redemption id itself — see that field's doc comment.</summary>
  public static StreamEventOccurredNotification DispatchRedemption(ChannelPointsCustomRewardRedemptionArgs args, DateTimeOffset now)
  {
    var e = args.Payload.Event;
    var detail = $"redeemed \"{e.Reward.Title}\"";
    var streamEvent = new StreamEvent(e.Id, "redeem", e.UserName, detail, "info", now);
    return new StreamEventOccurredNotification(streamEvent);
  }

  public static StreamEventOccurredNotification DispatchAdBreak(ChannelAdBreakBeginArgs args, DateTimeOffset now)
  {
    var e = args.Payload.Event;
    var detail = $"ad break · {e.DurationSeconds}s";
    var streamEvent = new StreamEvent(Guid.NewGuid().ToString(), "ad_break", "Twitch", detail, "info", now);
    return new StreamEventOccurredNotification(streamEvent);
  }

  public static WhisperReceivedNotification DispatchWhisper(UserWhisperMessageArgs args, DateTimeOffset now)
  {
    var e = args.Payload.Event;
    var displayName = string.IsNullOrEmpty(e.FromUserName) ? e.FromUserLogin : e.FromUserName;
    var whisperId = string.IsNullOrEmpty(e.WhisperId) ? Guid.NewGuid().ToString() : e.WhisperId;
    var whisper = new WhisperMessage(whisperId, e.FromUserLogin, displayName, e.Whisper.Text, now);
    return new WhisperReceivedNotification(whisper);
  }

  /// <summary>
  /// No-op scaffolding for Phase 8's category-module coordinator — see
  /// <see cref="CategorySignalNotification"/>'s doc comment. An empty/whitespace category id or
  /// name normalizes to null (matches legacy's <c>gameId || null</c>): Twitch reports an empty
  /// string, never omits the field, when the channel genuinely has no category set.
  /// </summary>
  public static CategorySignalNotification DispatchChannelUpdate(ChannelUpdateArgs args)
  {
    var e = args.Payload.Event;
    var gameId = string.IsNullOrWhiteSpace(e.CategoryId) ? null : e.CategoryId.Trim();
    var gameName = string.IsNullOrWhiteSpace(e.CategoryName) ? null : e.CategoryName.Trim();
    return new CategorySignalNotification(gameId, gameName);
  }

  public static StreamOnlineNotification DispatchStreamOnline(StreamOnlineArgs args)
  {
    var e = args.Payload.Event;
    return new StreamOnlineNotification(e.Id, e.StartedAt);
  }

  public static StreamOfflineNotification DispatchStreamOffline(StreamOfflineArgs _) => new();

  public static AutomodHeldNotification DispatchAutomodHold(AutomodMessageHoldV2Args args)
  {
    var e = args.Payload.Event;
    return new AutomodHeldNotification(e.MessageId, e.UserLogin, e.UserName, e.Message.Text, e.Reason, e.HeldAt);
  }

  public static AutomodResolvedNotification DispatchAutomodUpdate(AutomodMessageUpdateV2Args args)
  {
    var e = args.Payload.Event;
    return new AutomodResolvedNotification(e.MessageId, e.Status, e.ModeratorUserName);
  }

  private static string ReasonOrDefault(string? reason) => string.IsNullOrEmpty(reason) ? "no reason provided" : reason;

  private static string TierLabel(string tier) => tier switch
  {
    "2000" => "Tier 2",
    "3000" => "Tier 3",
    _ => "Tier 1",
  };

  private static string ResubDetail(string tier, int cumulativeMonths)
  {
    var label = TierLabel(tier);
    return cumulativeMonths > 0
      ? $"resub · {label} · {cumulativeMonths} month{(cumulativeMonths != 1 ? "s" : "")}"
      : $"resub · {label}";
  }

  private static Dictionary<string, string>? ToBadgeDictionary(TwitchChatBadge[] badges)
  {
    if (badges.Length == 0)
    {
      return null;
    }

    Dictionary<string, string> dictionary = new(StringComparer.Ordinal);
    foreach (var badge in badges)
    {
      dictionary[badge.SetId] = badge.Id;
    }

    return dictionary;
  }
}
