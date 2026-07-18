using System.Text.Json;

using Marten;

using Narya.Core.Chat;
using Narya.Database.Viewers;

namespace Narya.Database.Chat;

public sealed class ChatStore(IDocumentStore store) : IChatStore
{
  public async Task<ChatEventAppendResult> AppendChatEventAsync(
    string type,
    string channel,
    string payloadJson,
    string? messageId,
    string? username,
    DateTimeOffset occurredAt,
    CancellationToken cancellationToken)
  {
    var doc = new ChatEventDocument
    {
      Id = Guid.NewGuid(),
      Type = type,
      Channel = channel,
      MessageId = messageId,
      Username = username,
      PayloadJson = payloadJson,
      OccurredAt = occurredAt,
    };

    await using var session = store.LightweightSession();
    session.Insert(doc);
    await session.SaveChangesAsync(cancellationToken);

    return new ChatEventAppendResult(doc.Id, doc.OccurredAt);
  }

  public async Task<bool> TryInsertMessageAsync(ChatMessage message, CancellationToken cancellationToken)
  {
    await using var session = store.LightweightSession();

    var existing = await session.LoadAsync<ChatMessageDocument>(message.Id, cancellationToken);
    if (existing is not null)
    {
      return false;
    }

    var doc = new ChatMessageDocument
    {
      Id = message.Id,
      Channel = message.Channel,
      Username = message.Username,
      DisplayName = message.DisplayName,
      Color = message.Color,
      Message = message.Message,
      ReceivedAt = message.ReceivedAt,
      DeletedAt = null,
      DeletedReason = null,
      ModerationEventId = null,
      BadgesJson = SerializeBadges(message.Badges),
      EmotesJson = null,
      StreamSessionId = message.SessionId,
      IsFirstInSession = message.IsFirstThisSession,
      IsFirstEver = message.IsFirstEver,
      ChatterUserId = message.ChatterUserId,
    };

    session.Insert(doc);
    await session.SaveChangesAsync(cancellationToken);

    return true;
  }

  public async Task<bool> HasSeenChatterBeforeAsync(string login, CancellationToken cancellationToken)
  {
    await using var session = store.QuerySession();
    var existing = await session.LoadAsync<ChatterDocument>(login.ToLowerInvariant(), cancellationToken);
    return existing is not null;
  }

  public async Task UpsertChatterAsync(
    string login,
    DateTimeOffset occurredAt,
    string displayName,
    string? color,
    IReadOnlyDictionary<string, string>? badges,
    CancellationToken cancellationToken)
  {
    var loginKey = login.ToLowerInvariant();
    var badgesJson = SerializeBadges(badges);

    await using var session = store.LightweightSession();
    var existing = await session.LoadAsync<ChatterDocument>(loginKey, cancellationToken);

    var updated = existing is null
      ? new ChatterDocument
      {
        Login = loginKey,
        FirstSeenAt = occurredAt,
        MessageCount = 1,
        LastSeenAt = occurredAt,
        LastDisplayName = displayName,
        LastColor = color,
        LastBadgesJson = badgesJson,
      }
      : existing with
      {
        MessageCount = existing.MessageCount + 1,
        LastSeenAt = occurredAt,
        LastDisplayName = displayName,
        LastColor = color,
        LastBadgesJson = badgesJson,
      };

    session.Store(updated);
    await session.SaveChangesAsync(cancellationToken);
  }

  public async Task<IReadOnlyList<ChatMessage>> GetRecentMessagesAsync(int limit, CancellationToken cancellationToken)
  {
    await using var session = store.QuerySession();
    var docs = await session.Query<ChatMessageDocument>()
      .OrderByDescending(m => m.ReceivedAt)
      .Take(limit)
      .ToListAsync(cancellationToken);

    // docs is the `limit` most-recent rows, newest-first; re-sort ascending for the oldest→newest
    // response shape (matches legacy's SQL-desc-then-JS-.reverse() — see IChatStore's doc comment).
    return [.. docs.OrderBy(m => m.ReceivedAt).Select(ToChatMessage)];
  }

  public async Task<IReadOnlyList<ChatEvent>> GetRecentEventsAsync(int limit, CancellationToken cancellationToken)
  {
    await using var session = store.QuerySession();
    var docs = await session.Query<ChatEventDocument>()
      .OrderByDescending(e => e.OccurredAt)
      .Take(limit)
      .ToListAsync(cancellationToken);

    return [.. docs.OrderBy(e => e.OccurredAt).Select(ToChatEvent)];
  }

  public async Task<int> MarkMessageDeletedAsync(
    string messageId,
    DateTimeOffset deletedAt,
    string deletedReason,
    Guid moderationEventId,
    CancellationToken cancellationToken)
  {
    await using var session = store.LightweightSession();
    var existing = await session.LoadAsync<ChatMessageDocument>(messageId, cancellationToken);
    if (existing is null)
    {
      return 0;
    }

    session.Store(existing with
    {
      DeletedAt = deletedAt,
      DeletedReason = deletedReason,
      ModerationEventId = moderationEventId.ToString(),
    });
    await session.SaveChangesAsync(cancellationToken);

    return 1;
  }

  public async Task<int> MarkUserMessagesDeletedAsync(
    string channel,
    string username,
    DateTimeOffset deletedAt,
    string deletedReason,
    Guid moderationEventId,
    CancellationToken cancellationToken)
  {
    var loginKey = username.ToLowerInvariant();

    await using var session = store.LightweightSession();
    var undeleted = await session.Query<ChatMessageDocument>()
      .Where(m => m.Channel == channel && m.Username == loginKey && m.DeletedAt == null)
      .ToListAsync(cancellationToken);

    foreach (var doc in undeleted)
    {
      session.Store(doc with
      {
        DeletedAt = deletedAt,
        DeletedReason = deletedReason,
        ModerationEventId = moderationEventId.ToString(),
      });
    }

    await session.SaveChangesAsync(cancellationToken);

    return undeleted.Count;
  }

  public async Task<int> MarkChannelMessagesDeletedAsync(
    string channel,
    DateTimeOffset deletedAt,
    string deletedReason,
    Guid moderationEventId,
    CancellationToken cancellationToken)
  {
    await using var session = store.LightweightSession();
    var undeleted = await session.Query<ChatMessageDocument>()
      .Where(m => m.Channel == channel && m.DeletedAt == null)
      .ToListAsync(cancellationToken);

    foreach (var doc in undeleted)
    {
      session.Store(doc with
      {
        DeletedAt = deletedAt,
        DeletedReason = deletedReason,
        ModerationEventId = moderationEventId.ToString(),
      });
    }

    await session.SaveChangesAsync(cancellationToken);

    return undeleted.Count;
  }

  public async Task<IReadOnlyList<ChatMessage>> GetMessagesByUsernameAsync(
    string username, string? beforeId, int limit, CancellationToken cancellationToken)
  {
    var loginKey = username.ToLowerInvariant();
    await using var session = store.QuerySession();

    var filtered = session.Query<ChatMessageDocument>().Where(m => m.Username == loginKey);

    if (beforeId is not null)
    {
      var anchor = await session.LoadAsync<ChatMessageDocument>(beforeId, cancellationToken);
      if (anchor is not null)
      {
        filtered = filtered.Where(m => m.ReceivedAt < anchor.ReceivedAt);
      }
    }

    var docs = await filtered
      .OrderByDescending(m => m.ReceivedAt)
      .Take(limit)
      .ToListAsync(cancellationToken);

    // Reversed to oldest→newest, same convention as GetRecentMessagesAsync — but, unlike that
    // route, SessionId travels with each message (see this method's IChatStore doc comment).
    return [.. docs.OrderBy(m => m.ReceivedAt).Select(ToChatMessageWithSession)];
  }

  private static string? SerializeBadges(IReadOnlyDictionary<string, string>? badges) =>
    badges is null ? null : JsonSerializer.Serialize(badges);

  /// <summary>
  /// <see cref="ChatMessage.SessionId"/> is always <see langword="null"/> here — see
  /// <see cref="IChatStore.GetRecentMessagesAsync"/>'s doc comment for why this route
  /// deliberately omits it, matching legacy. <see cref="ChatMessage.IsFirstTimer"/> mirrors
  /// <see cref="ChatMessageDocument.IsFirstEver"/> — there is no separate stored column for it,
  /// same as legacy's read-time derivation.
  /// </summary>
  private static ChatMessage ToChatMessage(ChatMessageDocument doc)
  {
    var badges = doc.BadgesJson is null
      ? null
      : JsonSerializer.Deserialize<Dictionary<string, string>>(doc.BadgesJson);

    return new ChatMessage(
      Id: doc.Id,
      Channel: doc.Channel,
      Username: doc.Username,
      DisplayName: doc.DisplayName,
      Color: doc.Color,
      Message: doc.Message,
      ReceivedAt: doc.ReceivedAt,
      Badges: badges,
      ChatterUserId: doc.ChatterUserId,
      IsFirstTimer: doc.IsFirstEver,
      IsFirstThisSession: doc.IsFirstInSession,
      IsFirstEver: doc.IsFirstEver,
      SessionId: null,
      DeletedAt: doc.DeletedAt,
      DeletedReason: doc.DeletedReason);
  }

  /// <summary>
  /// Like <see cref="ToChatMessage"/>, but carries <see cref="ChatMessageDocument.StreamSessionId"/>
  /// through as <see cref="ChatMessage.SessionId"/> instead of nulling it — used only by
  /// <see cref="GetMessagesByUsernameAsync"/>, whose legacy route (<c>GET
  /// /api/viewers/:login/messages</c>) includes <c>sessionId</c>, unlike <c>GET /api/chat/recent</c>.
  /// </summary>
  private static ChatMessage ToChatMessageWithSession(ChatMessageDocument doc)
  {
    var badges = doc.BadgesJson is null
      ? null
      : JsonSerializer.Deserialize<Dictionary<string, string>>(doc.BadgesJson);

    return new ChatMessage(
      Id: doc.Id,
      Channel: doc.Channel,
      Username: doc.Username,
      DisplayName: doc.DisplayName,
      Color: doc.Color,
      Message: doc.Message,
      ReceivedAt: doc.ReceivedAt,
      Badges: badges,
      ChatterUserId: doc.ChatterUserId,
      IsFirstTimer: doc.IsFirstEver,
      IsFirstThisSession: doc.IsFirstInSession,
      IsFirstEver: doc.IsFirstEver,
      SessionId: doc.StreamSessionId,
      DeletedAt: doc.DeletedAt,
      DeletedReason: doc.DeletedReason);
  }

  private static ChatEvent ToChatEvent(ChatEventDocument doc)
  {
    using var parsed = JsonDocument.Parse(doc.PayloadJson);
    return new ChatEvent(doc.Id, doc.Type, doc.Channel, doc.MessageId, doc.Username, parsed.RootElement.Clone(), doc.OccurredAt);
  }
}
