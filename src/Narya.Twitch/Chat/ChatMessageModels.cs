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
/// active stream session. Phase 3's persistence handler fills these in before broadcasting to
/// clients; the values here are what the dispatcher itself can know from the EventSub payload
/// alone.
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
