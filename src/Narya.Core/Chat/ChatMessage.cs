namespace Narya.Core.Chat;

/// <summary>
/// A chat message, ready to persist and broadcast. Mirrors legacy's <c>ChatMessage</c>
/// (<c>legacy/src/shared/api.ts</c>) field-for-field: <see cref="Username"/> is always
/// lowercased (the login), <see cref="DisplayName"/> preserves Twitch's cased display name,
/// and <see cref="Badges"/> — not a resolved role — is what travels on the wire, exactly like
/// legacy; a role is derived from it on demand via <c>Narya.Twitch.Chat.IChatRoleResolver</c>
/// wherever one is needed (e.g. a future viewer-command role check), not stored redundantly
/// here.
///
/// Originally defined in <c>Narya.Twitch.Chat</c> (Phase 2, as <c>ChatMessage</c> alongside
/// <c>ChatMessageReceivedNotification</c>); moved here in Phase 3 because the notification
/// split's persistence/enrichment handler —
/// <c>Narya.Application.Chat.PersistChatMessageHandler</c> — lives in Narya.Application, and
/// Narya.Application deliberately does not reference Narya.Twitch (see
/// <c>Narya.Application.csproj</c>: only Narya.Core/Narya.Domain). This is the same move
/// <c>StreamOnlineNotification</c>/<c>StreamOfflineNotification</c> made for Sessions — see
/// <c>Narya.Core.Sessions.StreamOnlineNotification</c>'s doc comment.
///
/// <see cref="IsFirstTimer"/>/<see cref="IsFirstThisSession"/>/<see cref="IsFirstEver"/> and
/// <see cref="SessionId"/> default false/null on the RAW, ingested message — Phase 2's
/// EventSub dispatcher is a pure translation with no database access, so it cannot know a
/// chatter's history or the active stream session.
/// <c>Narya.Application.Chat.PersistChatMessageHandler</c> computes the real values and
/// republishes an enriched copy as <c>Narya.Application.Chat.ChatMessageBroadcastNotification</c>
/// — the ingested→broadcast split this record's move enables. <b>Note:</b>
/// <see cref="IsFirstTimer"/> and <see cref="IsFirstEver"/> are always set to the identical
/// computed value by that handler — legacy's <c>chat_messages</c> schema only ever stored one
/// underlying column (<c>is_first_ever</c>) and derived <c>isFirstTimer</c> from it on read
/// (<c>legacy/src/server/routes.ts</c>'s <c>GET /api/chat/recent</c>: <c>isFirstTimer:
/// Boolean(r.isFirstEver)</c>); there is no independent "first timer" concept in this domain.
///
/// <see cref="ChatterUserId"/> is Twitch's stable numeric user id for the chatter — distinct
/// from <see cref="Username"/>, which is the login and can be reused if an account is renamed.
/// Message fragments/emotes (TwitchLib's <c>Message.Fragments</c>) are deliberately not
/// captured here — left for a later phase (see
/// <see cref="Narya.Database.Chat.ChatMessageDocument"/>'s <c>EmotesJson</c> doc comment for
/// how the storage layer still reserves the column).
///
/// <see cref="DeletedAt"/>/<see cref="DeletedReason"/> default null on a freshly-ingested
/// message — added in Task 2 (moderation soft-delete) so <c>GET /api/chat/recent</c> can surface
/// a moderated message's reason (mirrors legacy's <c>deletedAt</c>/<c>deletedReason</c> columns,
/// <c>legacy/src/shared/api.ts</c>). Appended at the end of the parameter list, both defaulted,
/// so every existing call site (which all use named arguments) keeps compiling unchanged.
/// <c>Narya.Database.Chat.ChatStore.TryInsertMessageAsync</c> ignores them on insert (a fresh
/// message is never pre-deleted); only the soft-delete ops
/// (<c>Narya.Core.Chat.IChatStore.MarkMessageDeletedAsync</c> and friends) and the
/// <c>GetRecentMessagesAsync</c> read path populate them.
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
  string? SessionId = null,
  DateTimeOffset? DeletedAt = null,
  string? DeletedReason = null);

/// <summary>
/// A moderation action affecting one or more chat messages. Mirrors legacy's
/// <c>ChatModerationEvent</c> (<c>legacy/src/shared/api.ts</c>): <see cref="Type"/> is one of
/// <c>message.deleted</c>, <c>user.timeout</c>, <c>user.ban</c>, or <c>chat.clear</c> — the
/// same closed set legacy's chat projection used for tmi.js moderation events, now populated
/// from EventSub instead. Moved alongside <see cref="ChatMessage"/> — see that record's doc
/// comment for why.
/// </summary>
public sealed record ChatModerationEvent(
  string Type,
  string Channel,
  string? MessageId,
  string? Username,
  DateTimeOffset DeletedAt,
  string DeletedReason);
