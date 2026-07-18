namespace Narya.Twitch.Chat;

/// <summary>
/// A chat message, ready to persist and broadcast. Mirrors legacy's <c>ChatMessage</c>
/// (<c>legacy/src/shared/api.ts</c>) field-for-field: <see cref="Username"/> is always
/// lowercased (the login), <see cref="DisplayName"/> preserves Twitch's cased display name,
/// and <see cref="Badges"/> — not a resolved <see cref="Chat.ChatRole"/> — is what travels on
/// the wire, exactly like legacy; a role is derived from it on demand via
/// <see cref="IChatRoleResolver"/> wherever one is needed (e.g. a future viewer-command
/// role check), not stored redundantly here.
///
/// <see cref="IsFirstTimer"/>/<see cref="IsFirstThisSession"/>/<see cref="IsFirstEver"/> and
/// <see cref="SessionId"/> default false/null — Phase 2's <see cref="EventSub.EventSubDispatcher"/>
/// is a pure translation with no database access, so it cannot know a chatter's history or the
/// active stream session. <b>THIS IS THE ACTUAL PHASE 2 BEHAVIOR, not a placeholder</b>: every
/// chat message Narya broadcasts today carries these fields false/null, unconditionally — there
/// is no first-timer or session tracking yet, and nothing downstream should assume otherwise.
///
/// An earlier version of this comment claimed "Phase 3's persistence handler fills these in
/// before broadcasting to clients." That is not achievable as the notification is currently
/// shaped: <see cref="EventSub.Notifications.ChatMessageReceivedNotification"/> is an
/// <c>IRealtimeNotification</c>, so Phase 1's realtime bridge broadcasts this exact, immutable
/// record to overlay/dashboard clients the instant MediatR publishes it — there is no
/// guaranteed handler ordering that would let a persistence/enrichment handler run and mutate
/// these fields FIRST, and a <c>record</c>'s already-broadcast copy could not be mutated after
/// the fact even if there were. Phase 3's real plan is to split the single publish into two
/// notifications: an internal "ingested" <c>INotification</c> (no broadcast obligation — this
/// is where chatter-history and session lookups happen) and a separate "broadcast"
/// <c>IRealtimeNotification</c> that the enrichment handler raises only once it has computed
/// the real values. Until that split lands, treat every consumer of this record as seeing the
/// un-enriched values above. <see cref="EventSub.Notifications.StreamEvent"/> has the same gap
/// for session scoping — see that record's doc comment.
///
/// <see cref="ChatterUserId"/> is Twitch's stable numeric user id for the chatter — distinct
/// from <see cref="Username"/>, which is the login and can be reused if an account is renamed.
/// The spec's dispatch table lists it because Phase 3 needs a stable key for persistence, dedup,
/// and viewer lookups; <see cref="EventSub.EventSubDispatcher.DispatchChatMessage"/> is what
/// populates it, straight from the EventSub payload's <c>chatter_user_id</c>. Message
/// fragments/emotes (TwitchLib's <c>Message.Fragments</c>) are deliberately not captured here —
/// left for a later phase.
/// </summary>
public sealed record ChatMessage(
  string Id,
  string Channel,
  string Username,
  string DisplayName,
  string? Color,
  string Message,
  DateTimeOffset ReceivedAt,
  IReadOnlyDictionary<string, string>? Badges,
  string ChatterUserId,
  bool IsFirstTimer = false,
  bool IsFirstThisSession = false,
  bool IsFirstEver = false,
  string? SessionId = null);

/// <summary>
/// A moderation action affecting one or more chat messages. Mirrors legacy's
/// <c>ChatModerationEvent</c> (<c>legacy/src/shared/api.ts</c>): <see cref="Type"/> is one of
/// <c>message.deleted</c>, <c>user.timeout</c>, <c>user.ban</c>, or <c>chat.clear</c> — the
/// same closed set legacy's chat projection used for tmi.js moderation events, now populated
/// from EventSub instead (<see cref="EventSub.EventSubDispatcher"/>'s doc comment covers which
/// EventSub subscription produces which <see cref="Type"/>).
/// </summary>
public sealed record ChatModerationEvent(
  string Type,
  string Channel,
  string? MessageId,
  string? Username,
  DateTimeOffset DeletedAt,
  string DeletedReason);
