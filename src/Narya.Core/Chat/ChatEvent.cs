using System.Text.Json;

namespace Narya.Core.Chat;

/// <summary>
/// The result of <see cref="IChatStore.AppendChatEventAsync"/> — the append-only ledger row's
/// identity and timestamp, handed back so a caller can link a later mutation (e.g. a moderation
/// soft-delete's <c>ModerationEventId</c>, Task 2) to the event that caused it. Mirrors legacy's
/// <c>appendChatEvent</c> return shape (<c>legacy/src/server/chat.ts</c>: <c>{ id, occurredAt }</c>).
/// </summary>
public sealed record ChatEventAppendResult(Guid Id, DateTimeOffset OccurredAt);

/// <summary>
/// A row from the append-only <c>chat_events</c> ledger, read back for
/// <c>GET /api/chat/events/recent</c>. Mirrors legacy's row shape
/// (<c>legacy/src/server/routes.ts</c>): <see cref="Payload"/> is the event's
/// <c>payload_json</c> column parsed into a <see cref="JsonElement"/> so it serializes back out
/// as nested JSON rather than a doubly-escaped string, exactly like legacy's
/// <c>parseJsonColumn</c>. There is no shared client type for this response in legacy — this is
/// the first typed contract for it.
/// </summary>
public sealed record ChatEvent(
  Guid Id,
  string Type,
  string Channel,
  string? MessageId,
  string? Username,
  JsonElement Payload,
  DateTimeOffset OccurredAt);
