using Narya.Core.Automod;
using Narya.Core.Chat;
using Narya.Core.Events;
using Narya.Core.Sessions;
using Narya.Twitch.EventSub.Notifications;

using TwitchLib.EventSub.Core.EventArgs.Automod;
using TwitchLib.EventSub.Core.EventArgs.Channel;
using TwitchLib.EventSub.Core.EventArgs.Stream;
using TwitchLib.EventSub.Core.EventArgs.User;

// TwitchLib.EventSub.Core.Models.Chat.ChatMessage/ChatBadge share their simple names with our
// own Narya.Core.Chat.ChatMessage (moved here from Narya.Twitch.Chat in Phase 3 — see that
// record's doc comment) and would collide under a plain `using` — the same EventSubSubscription
// collision Phase 2 Task 5 already worked around (see that task's report).
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
  /// not", kept pure and separately testable from the stateful lookup around it. This is the
  /// message-arrives side of the merge; <see cref="ShouldSkipSubscribeForPendingMessage"/> is
  /// its symmetric counterpart for the subscribe-arrives side.
  /// </summary>
  public static bool ShouldMergeSubscriptionMessage(DateTimeOffset pendingSubscribedAt, DateTimeOffset now) =>
    now >= pendingSubscribedAt && now - pendingSubscribedAt <= SubscriptionMergeWindow;

  /// <summary>
  /// The symmetric merge decision for the OTHER delivery order: Twitch does not guarantee
  /// <c>channel.subscribe</c> arrives before <c>channel.subscription.message</c> for a resub
  /// (legacy's <c>eventsub.ts</c> documents this and handles both — its <c>takeRecentSub</c> is
  /// consulted from both the subscribe AND the message branch). True when a
  /// <c>channel.subscription.message</c> already landed for this chatter within
  /// <see cref="SubscriptionMergeWindow"/> — <paramref name="pending"/> has a value and its
  /// <c>HasMessage</c> is set — meaning the richer resub stream event it already published makes
  /// this "new sub" notification redundant, so <see cref="TwitchEventSubService.OnChannelSubscribeAsync"/>
  /// must skip publishing rather than emit a duplicate on-screen alert. A pending entry that is
  /// still a plain, not-yet-merged subscribe (<c>HasMessage</c> false) does not trigger a skip —
  /// that is a different subscribe, not the other half of an in-flight merge. <c>internal</c>
  /// (rather than <c>public</c>) because <see cref="TwitchEventSubService.PendingSubscription"/>
  /// is itself <c>internal</c>.
  /// </summary>
  internal static bool ShouldSkipSubscribeForPendingMessage(TwitchEventSubService.PendingSubscription? pending, DateTimeOffset now) =>
    pending is { HasMessage: true } value && ShouldMergeSubscriptionMessage(value.SubscribedAt, now);

  /// <summary>
  /// Bot-loop guard: a message whose <c>chatter_user_login</c> matches
  /// <paramref name="botLogin"/> (case-insensitive; comparison skipped entirely when
  /// <paramref name="botLogin"/> is null/empty, i.e. no bot account configured) returns null —
  /// the bot's own chat messages (e.g. <c>!tts</c> replies) must never re-enter chat ingestion.
  /// <paramref name="now"/> is supplied by the caller rather than read from a clock in here,
  /// keeping this method a pure function of its inputs.
  /// </summary>
  public static ChatMessageIngestedNotification? DispatchChatMessage(
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
      Badges: ToBadgeDictionary(e.Badges),
      ChatterUserId: e.ChatterUserId);

    return new ChatMessageIngestedNotification(message);
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
  /// reason. Legacy's <c>eventsub.ts</c> also subscribed <c>channel.moderate</c> v2 as a richer
  /// source carrying the actual ban/timeout reason for the same underlying action — Narya does
  /// NOT (see <see cref="EventSubSubscriptions"/>'s doc comment at the removal site): v2 needs a
  /// broad set of <c>moderator:read</c>/<c>moderator:manage</c> scopes beyond
  /// <see cref="Scopes.Broadcaster"/>, and granting them is deferred to Phase 3 as the
  /// operator's call once moderation persistence actually needs the richer data. This method is
  /// therefore the ONLY source of a ban/timeout <see cref="ChatModerationEvent"/> today — no
  /// dedup concern, since there is no second dispatch path to double-fire against.
  /// </summary>
  public static ChatModeratedNotification DispatchChatClearUserMessages(ChannelChatClearUserMessagesArgs args, DateTimeOffset now)
  {
    var e = args.Payload.Event;
    var moderationEvent = new ChatModerationEvent(
      "user.timeout", e.BroadcasterUserLogin, MessageId: null, e.TargetUserLogin, now, "messages cleared");
    return new ChatModeratedNotification(moderationEvent);
  }

  public static StreamEventIngestedNotification DispatchFollow(ChannelFollowArgs args, DateTimeOffset now)
  {
    var e = args.Payload.Event;
    var streamEvent = new StreamEvent(Guid.NewGuid().ToString(), "follow", e.UserName, "followed", "silver", now, ActorLogin: e.UserLogin);
    return new StreamEventIngestedNotification(streamEvent);
  }

  /// <summary>
  /// Null when <c>is_gift</c> is set — a gifted sub's "who received it" notification is
  /// <c>channel.subscription.gift</c> (<see cref="DispatchGift"/>), not this one; Twitch still
  /// fires <c>channel.subscribe</c> for each recipient, and surfacing both would double-count
  /// the sub as two stream events. Matches legacy's <c>if (event.is_gift) break;</c>.
  /// </summary>
  public static StreamEventIngestedNotification? DispatchSubscribe(ChannelSubscribeArgs args, DateTimeOffset now)
  {
    var e = args.Payload.Event;
    if (e.IsGift)
    {
      return null;
    }

    var detail = $"new sub · {TierLabel(e.Tier)}";
    var streamEvent = new StreamEvent(Guid.NewGuid().ToString(), "sub", e.UserName, detail, "warning", now, ActorLogin: e.UserLogin);
    return new StreamEventIngestedNotification(streamEvent);
  }

  /// <summary>
  /// The "no pending subscribe to merge into" path: either a monthly resub (Twitch never fires
  /// <c>channel.subscribe</c> for those, only this) or the merge window already lapsed. Builds
  /// a brand-new <see cref="StreamEvent"/> with the full resub detail
  /// (<see cref="ResubDetail"/>) rather than the bare "new sub" wording.
  /// </summary>
  public static StreamEventIngestedNotification DispatchSubscriptionMessageAsNewEvent(
    ChannelSubscriptionMessageArgs args, DateTimeOffset now)
  {
    var e = args.Payload.Event;
    var streamEvent = new StreamEvent(
      Guid.NewGuid().ToString(), "sub", e.UserName, ResubDetail(e.Tier, e.CumulativeMonths), "warning", now, ActorLogin: e.UserLogin);
    return new StreamEventIngestedNotification(streamEvent);
  }

  /// <summary>
  /// The merge path: updates the <see cref="StreamEvent"/> a preceding <c>channel.subscribe</c>
  /// already emitted (<paramref name="pendingStreamEventId"/>) with the richer resub detail,
  /// instead of emitting a second stream event for the same subscription.
  /// </summary>
  public static StreamEventUpdateIngestedNotification DispatchSubscriptionMessageAsMerge(
    ChannelSubscriptionMessageArgs args, string pendingStreamEventId)
  {
    var e = args.Payload.Event;
    var update = new StreamEventUpdate(pendingStreamEventId, ResubDetail(e.Tier, e.CumulativeMonths), "warning");
    return new StreamEventUpdateIngestedNotification(update);
  }

  public static StreamEventIngestedNotification DispatchGift(ChannelSubscriptionGiftArgs args, DateTimeOffset now)
  {
    var e = args.Payload.Event;
    var gifter = string.IsNullOrEmpty(e.UserName) ? "Anonymous" : e.UserName;
    var detail = $"gifted {e.Total} sub{(e.Total != 1 ? "s" : "")} to the channel";
    var streamEvent = new StreamEvent(Guid.NewGuid().ToString(), "gift", gifter, detail, "warning", now, ActorLogin: e.UserLogin);
    return new StreamEventIngestedNotification(streamEvent);
  }

  public static StreamEventIngestedNotification DispatchCheer(ChannelCheerArgs args, DateTimeOffset now)
  {
    var e = args.Payload.Event;
    var cheerer = string.IsNullOrEmpty(e.UserName) ? "Anonymous" : e.UserName;
    var detail = $"cheered {e.Bits} bits";
    var streamEvent = new StreamEvent(Guid.NewGuid().ToString(), "cheer", cheerer, detail, "info", now, ActorLogin: e.UserLogin);
    return new StreamEventIngestedNotification(streamEvent);
  }

  public static StreamEventIngestedNotification DispatchRaid(ChannelRaidArgs args, DateTimeOffset now)
  {
    var e = args.Payload.Event;
    var detail = $"raided with {e.Viewers} viewer{(e.Viewers != 1 ? "s" : "")}";
    var streamEvent = new StreamEvent(
      Guid.NewGuid().ToString(), "raid", e.FromBroadcasterUserName, detail, "note", now, ActorLogin: e.FromBroadcasterUserLogin);
    return new StreamEventIngestedNotification(streamEvent);
  }

  /// <summary><see cref="StreamEvent.Id"/> is the Twitch redemption id itself — see that field's doc comment.</summary>
  public static StreamEventIngestedNotification DispatchRedemption(ChannelPointsCustomRewardRedemptionArgs args, DateTimeOffset now)
  {
    var e = args.Payload.Event;
    var detail = $"redeemed \"{e.Reward.Title}\"";
    var streamEvent = new StreamEvent(e.Id, "redeem", e.UserName, detail, "info", now, ActorLogin: e.UserLogin);
    return new StreamEventIngestedNotification(streamEvent);
  }

  public static StreamEventIngestedNotification DispatchAdBreak(ChannelAdBreakBeginArgs args, DateTimeOffset now)
  {
    var e = args.Payload.Event;
    var detail = $"ad break · {e.DurationSeconds}s";
    var streamEvent = new StreamEvent(Guid.NewGuid().ToString(), "ad_break", "Twitch", detail, "info", now);
    return new StreamEventIngestedNotification(streamEvent);
  }

  /// <summary>
  /// <c>channel.chat.notification</c> covers a wide family of chat system messages (sub, resub,
  /// raid, announcement, ...) — every one of those already has its own dedicated EventSub
  /// subscription and dispatch method (<see cref="DispatchSubscribe"/>, <see cref="DispatchRaid"/>,
  /// ...), so handling them again here would double-fire the same stream event. Only
  /// <c>notice_type == "watch_streak"</c> produces anything — matching legacy's
  /// <c>eventsub.ts</c> <c>channel.chat.notification</c> case, which is likewise a no-op for
  /// every other notice type — and returns null otherwise.
  ///
  /// <b>Known gap</b> (Phase 2 Task 6 final-review Step 0 — verified by decompiling
  /// TwitchLib.EventSub.Core 3.0.0's <c>ChannelChatNotification</c> model and the raw assembly
  /// for any "watch_streak" string literal; see the Task 6 report for the full trace): the
  /// library has NO typed field for the watch-streak payload at all. <c>ChannelChatNotification.NoticeType</c>
  /// is a plain string Twitch populates correctly (so the <c>watch_streak</c> check below works),
  /// but there is no <c>WatchStreak</c> property or any extension-data bag anywhere on the type,
  /// and System.Text.Json silently drops unmapped JSON members by default — so the streak count
  /// Twitch sends in the real notification never survives deserialization into this object.
  /// There is therefore no way to reproduce legacy's exact <c>"watch streak · {N} months"</c>
  /// wording from this args type today; the detail is the generic <c>"watch streak"</c> until a
  /// future TwitchLib release models the field (or a later phase parses the raw notification
  /// JSON itself, which no other dispatch method in this class does).
  /// </summary>
  public static StreamEventIngestedNotification? DispatchChatNotification(ChannelChatNotificationArgs args, DateTimeOffset now)
  {
    var e = args.Payload.Event;
    if (!string.Equals(e.NoticeType, "watch_streak", StringComparison.Ordinal))
    {
      return null;
    }

    var streamEvent = new StreamEvent(
      Guid.NewGuid().ToString(), "redeem", e.ChatterUserName, "watch streak", "silver", now, ActorLogin: e.ChatterUserLogin);
    return new StreamEventIngestedNotification(streamEvent);
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

  /// <summary>
  /// <see cref="AutomodHeldNotification.Channel"/> carries Twitch's raw
  /// <c>BroadcasterUserLogin</c> through unresolved (possibly empty) — the config fallback
  /// (<c>?? appConfig.twitchChannel</c> in legacy) requires I/O this pure dispatcher cannot
  /// perform; <c>Narya.Application.Automod.RecordAutomodHoldHandler</c> applies it.
  /// <see cref="AutomodHeldNotification.Category"/>/<see cref="AutomodHeldNotification.Level"/>
  /// come from the nested <c>Automod</c> object, which Twitch omits when the hold was caught by
  /// a blocked term instead — <c>e.Automod?.Category</c>/<c>e.Automod?.Level</c> null-propagate
  /// to match legacy's <c>automod?.category ?? null</c>/<c>automod?.level ?? null</c>.
  /// </summary>
  public static AutomodHeldNotification DispatchAutomodHold(AutomodMessageHoldV2Args args)
  {
    var e = args.Payload.Event;
    return new AutomodHeldNotification(
      e.MessageId, e.BroadcasterUserLogin, e.UserLogin, e.UserName, e.Message.Text, e.Reason,
      e.Automod?.Category, e.Automod?.Level, e.HeldAt);
  }

  public static AutomodResolvedNotification DispatchAutomodUpdate(AutomodMessageUpdateV2Args args)
  {
    var e = args.Payload.Event;
    return new AutomodResolvedNotification(e.MessageId, e.Status, e.ModeratorUserName);
  }

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
