namespace Narya.Database.Chat;

/// <summary>
/// The mutable <c>chat_messages</c> projection — a port of legacy's table
/// (<c>legacy/src/server/db.ts</c>). <see cref="Id"/> is the Twitch message id itself (the
/// natural key <c>Narya.Database.Chat.ChatStore.TryInsertMessageAsync</c> dedups a redelivery
/// against — see that method's doc comment on <c>IChatStore</c>), not a synthetic identifier.
///
/// <see cref="DeletedAt"/>/<see cref="DeletedReason"/>/<see cref="ModerationEventId"/> are
/// always <see langword="null"/> on insert — Task 1 only ever writes a fresh, undeleted
/// message; Task 2's moderation soft-delete is what populates them later, linking back to the
/// <see cref="ChatEventDocument"/> that caused the deletion.
///
/// <see cref="EmotesJson"/> is reserved for schema parity with legacy's <c>emotes_json</c>
/// column but is never populated yet: Narya's Phase 2 EventSub chat ingestion
/// (<c>Narya.Twitch.EventSub.EventSubDispatcher.DispatchChatMessage</c>) deliberately does not
/// capture message fragments/emotes (see <c>Narya.Core.Chat.ChatMessage</c>'s doc comment) —
/// this column exists so a later phase can start populating it without a document migration.
/// </summary>
public sealed record ChatMessageDocument
{
  public string Id { get; init; } = string.Empty;

  public string Channel { get; init; } = string.Empty;

  /// <summary>Always lowercased — the login, not the display name.</summary>
  public string Username { get; init; } = string.Empty;

  public string DisplayName { get; init; } = string.Empty;

  public string? Color { get; init; }

  public string Message { get; init; } = string.Empty;

  public DateTimeOffset ReceivedAt { get; init; }

  public DateTimeOffset? DeletedAt { get; init; }

  public string? DeletedReason { get; init; }

  public string? ModerationEventId { get; init; }

  public string? BadgesJson { get; init; }

  public string? EmotesJson { get; init; }

  public string? StreamSessionId { get; init; }

  public bool IsFirstInSession { get; init; }

  public bool IsFirstEver { get; init; }

  /// <summary>Twitch's stable numeric user id for the chatter — see <c>Narya.Core.Chat.ChatMessage.ChatterUserId</c>'s doc comment.</summary>
  public string ChatterUserId { get; init; } = string.Empty;
}
