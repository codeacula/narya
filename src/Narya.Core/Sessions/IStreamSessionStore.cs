namespace Narya.Core.Sessions;

/// <summary>
/// Tracks stream broadcasts ("sessions") and, per session, which chatters have been seen
/// before. Implemented in Narya.Database (<c>StreamSessionStore</c>, a plain Marten
/// document store — see that class's doc comment for why this is a document rather than an
/// event-sourced aggregate); this interface is what the rest of the application depends on,
/// so that Narya.Application (which does not reference Narya.Database) can consume it.
///
/// <para>
/// At most one session is ever open (<see cref="StreamSession.EndedAt"/> null) at a time —
/// <see cref="GetOrStartSessionAsync"/> is the only place that invariant is enforced.
/// </para>
/// </summary>
public interface IStreamSessionStore
{
  /// <summary>The open session (newest by <c>StartedAt</c> if more than one is ever found), or null if none is open.</summary>
  Task<StreamSession?> GetActiveSessionAsync(CancellationToken cancellationToken);

  /// <summary>Shorthand for <c>(await GetActiveSessionAsync(...))?.Id</c>.</summary>
  Task<string?> GetCurrentSessionIdAsync(CancellationToken cancellationToken);

  /// <summary>
  /// Returns the existing session for <paramref name="source"/> if one already exists
  /// (idempotent — a redelivered/restarted <c>stream.online</c> for the same broadcast reuses
  /// the row rather than starting a second one). Otherwise, in a single transaction: closes
  /// any currently-open session(s) by setting their <c>EndedAt</c> to <paramref name="startedAt"/>,
  /// then inserts the new session with <c>EndedAt = null</c> — so at most one session is ever
  /// open.
  /// </summary>
  Task<StreamSession> GetOrStartSessionAsync(string source, DateTimeOffset startedAt, CancellationToken cancellationToken);

  /// <summary>Closes every currently-open session by setting <c>EndedAt</c> to <paramref name="endedAt"/>.</summary>
  Task EndActiveSessionAsync(DateTimeOffset endedAt, CancellationToken cancellationToken);

  /// <summary>
  /// Records that <paramref name="login"/> has chatted during the current session, keyed
  /// <c>"{sessionId}:{login}"</c> (case-insensitive on login). Insert-or-ignore: a login already
  /// recorded for the current session is a no-op. Returns the current session id (null when
  /// off-stream — no active session to record against) and whether this call was the one that
  /// inserted the row (false when off-stream, or when the login was already recorded).
  /// </summary>
  Task<SessionChatterResult> RecordCurrentSessionChatterAsync(
    string login, string messageId, DateTimeOffset occurredAt, CancellationToken cancellationToken);

  /// <summary>Count of distinct chatters recorded against the current session (0 when none is open).</summary>
  Task<int> GetSessionChatterCountAsync(CancellationToken cancellationToken);
}
