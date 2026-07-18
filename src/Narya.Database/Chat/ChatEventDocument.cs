namespace Narya.Database.Chat;

/// <summary>
/// The append-only <c>chat_events</c> ledger — a Marten document, never event-sourced (there is
/// nothing to project; each row IS the record). <see cref="Id"/> is a fresh
/// <see cref="Guid"/> per row; unlike <see cref="ChatMessageDocument"/>, there is no natural key
/// and no dedup — <c>Narya.Database.Chat.ChatStore.AppendChatEventAsync</c> always inserts,
/// even for a redelivered chat message, mirroring legacy's <c>appendChatEvent</c>
/// (<c>legacy/src/server/chat.ts</c>), which ran unconditionally ahead of the dedup'd
/// <c>chat_messages</c> insert.
/// </summary>
public sealed record ChatEventDocument
{
  public Guid Id { get; init; }

  /// <summary>One of <c>message.created</c>, <c>message.deleted</c>, <c>user.timeout</c>, <c>user.ban</c>, <c>chat.clear</c>, <c>automod.hold</c>, <c>automod.resolve</c>.</summary>
  public string Type { get; init; } = string.Empty;

  public string Channel { get; init; } = string.Empty;

  public string? MessageId { get; init; }

  public string? Username { get; init; }

  /// <summary>The event's payload, serialized — parsed back into a <see cref="System.Text.Json.JsonElement"/> for the read route.</summary>
  public string PayloadJson { get; init; } = string.Empty;

  public DateTimeOffset OccurredAt { get; init; }
}
