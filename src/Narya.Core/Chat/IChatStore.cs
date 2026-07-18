namespace Narya.Core.Chat;

/// <summary>
/// Dual-layer chat persistence — <c>chat_events</c> (append-only ledger) and
/// <c>chat_messages</c>/<c>chatters</c> (mutable projections) — a port of legacy's
/// <c>chat.ts</c>. Implemented by <c>Narya.Database.Chat.ChatStore</c>.
///
/// Deliberately defined here (Narya.Core), not alongside its implementation in Narya.Database:
/// <c>Narya.Application.Chat.PersistChatMessageHandler</c> is the consumer, and
/// Narya.Application deliberately does not reference Narya.Database — the same
/// reference-direction constraint documented on <see cref="ChatMessage"/> and
/// <see cref="ChatMessageIngestedNotification"/>. Registered as
/// <c>AddSingleton&lt;IChatStore, ChatStore&gt;</c> in
/// <c>Narya.Database.ServiceCollectionExtensions.AddNaryaDatabase</c>, alongside
/// <c>IAppConfigStore</c> and <c>IStreamSessionStore</c>.
/// </summary>
public interface IChatStore
{
  /// <summary>
  /// Appends a row to the append-only <c>chat_events</c> ledger. Never dedups — every call
  /// inserts a fresh row, even a redelivery of the same underlying chat message (mirrors
  /// legacy's <c>appendChatEvent</c>, which always ran ahead of the dedup'd
  /// <c>chat_messages</c> insert).
  /// </summary>
  Task<ChatEventAppendResult> AppendChatEventAsync(
    string type,
    string channel,
    string payloadJson,
    string? messageId,
    string? username,
    DateTimeOffset occurredAt,
    CancellationToken cancellationToken);

  /// <summary>
  /// Insert-or-ignore keyed by <see cref="ChatMessage.Id"/> (the Twitch message id) —
  /// load-check-then-insert, matching
  /// <c>Narya.Database.Sessions.StreamSessionStore.RecordCurrentSessionChatterAsync</c>'s
  /// pattern (never <c>session.Store</c>, which would silently overwrite a redelivery on top
  /// of the original). Returns <see langword="true"/> only on a genuine first insert; a
  /// redelivered id returns <see langword="false"/> and leaves the stored row untouched — the
  /// caller (<c>PersistChatMessageHandler</c>) must treat <see langword="false"/> as "stop, no
  /// enrichment, no chatters bump, no broadcast."
  /// </summary>
  Task<bool> TryInsertMessageAsync(ChatMessage message, CancellationToken cancellationToken);

  /// <summary>Whether a <c>chatters</c> document already exists for <paramref name="login"/> (case-insensitive).</summary>
  Task<bool> HasSeenChatterBeforeAsync(string login, CancellationToken cancellationToken);

  /// <summary>
  /// Upsert into <c>chatters</c>: first call for a login inserts with <c>MessageCount = 1</c>
  /// and the first-seen watermark; every subsequent call increments <c>MessageCount</c> and
  /// refreshes the last-message fields while preserving the original first-seen watermark.
  /// Unlike <see cref="TryInsertMessageAsync"/>, this is a genuine upsert (not a dedup guard) —
  /// the caller must only invoke it once per genuinely new chat message (i.e. only after
  /// <see cref="TryInsertMessageAsync"/> returned <see langword="true"/>).
  ///
  /// The last-message fields (<paramref name="displayName"/>/<paramref name="color"/>/
  /// <paramref name="badges"/>) are not part of legacy's <c>chatters</c> schema — they are
  /// maintained here ahead of Task 5's viewer roster specifically so that endpoint can scan
  /// <c>chatters</c> alone rather than joining <c>chat_messages</c> with a window function.
  /// </summary>
  Task UpsertChatterAsync(
    string login,
    DateTimeOffset occurredAt,
    string displayName,
    string? color,
    IReadOnlyDictionary<string, string>? badges,
    CancellationToken cancellationToken);

  /// <summary>
  /// The <paramref name="limit"/> most-recent <c>chat_messages</c>, oldest→newest — a port of
  /// legacy's <c>GET /api/chat/recent</c> (<c>order by received_at desc limit 40</c>, then
  /// reversed). <see cref="ChatMessage.SessionId"/> is always <see langword="null"/> on the
  /// returned messages: legacy's query never selected <c>stream_session_id</c> on this
  /// specific route, and this port preserves that (documented, deliberate) omission.
  /// </summary>
  Task<IReadOnlyList<ChatMessage>> GetRecentMessagesAsync(int limit, CancellationToken cancellationToken);

  /// <summary>
  /// The <paramref name="limit"/> most-recent <c>chat_events</c>, oldest→newest — a port of
  /// legacy's <c>GET /api/chat/events/recent</c> (<c>order by occurred_at desc limit 100</c>,
  /// then reversed).
  /// </summary>
  Task<IReadOnlyList<ChatEvent>> GetRecentEventsAsync(int limit, CancellationToken cancellationToken);

  /// <summary>
  /// Soft-deletes exactly one message by <paramref name="messageId"/> — a port of legacy's
  /// <c>markMessageDeleted</c> (<c>update chat_messages set ... where id = ?</c>). Deliberately
  /// carries NO <c>DeletedAt is null</c> guard, unlike
  /// <see cref="MarkUserMessagesDeletedAsync"/>/<see cref="MarkChannelMessagesDeletedAsync"/>:
  /// legacy's single-id statement unconditionally overwrites whatever soft-delete state (if any)
  /// was already there, so a redelivered <c>message.deleted</c> for the same id simply
  /// re-applies the same fields rather than being a no-op. Returns <c>0</c> (not an error) when
  /// <paramref name="messageId"/> does not match a stored message — the message may not have
  /// been ingested yet, or may never be (matches legacy, whose SQLite <c>update</c> is a silent
  /// no-op on zero matched rows).
  /// </summary>
  Task<int> MarkMessageDeletedAsync(
    string messageId,
    DateTimeOffset deletedAt,
    string deletedReason,
    Guid moderationEventId,
    CancellationToken cancellationToken);

  /// <summary>
  /// Soft-deletes every currently-undeleted message from <paramref name="username"/>
  /// (case-insensitive) in <paramref name="channel"/> — a port of legacy's
  /// <c>markUserMessagesDeleted</c> (<c>... where channel = ? and username = ? and deleted_at is
  /// null</c>). The <c>DeletedAt is null</c> filter is load-bearing for idempotency: a
  /// redelivered <c>user.timeout</c>/<c>user.ban</c> for the same user only touches rows a prior
  /// call left untouched, rather than re-stamping (and losing) an earlier, more specific
  /// soft-delete reason. Returns the number of rows updated.
  /// </summary>
  Task<int> MarkUserMessagesDeletedAsync(
    string channel,
    string username,
    DateTimeOffset deletedAt,
    string deletedReason,
    Guid moderationEventId,
    CancellationToken cancellationToken);

  /// <summary>
  /// Soft-deletes every currently-undeleted message in <paramref name="channel"/> — a port of
  /// legacy's <c>markChannelMessagesDeleted</c> (<c>... where channel = ? and deleted_at is
  /// null</c>). Same idempotency rationale as <see cref="MarkUserMessagesDeletedAsync"/>. Returns
  /// the number of rows updated.
  /// </summary>
  Task<int> MarkChannelMessagesDeletedAsync(
    string channel,
    DateTimeOffset deletedAt,
    string deletedReason,
    Guid moderationEventId,
    CancellationToken cancellationToken);
}
