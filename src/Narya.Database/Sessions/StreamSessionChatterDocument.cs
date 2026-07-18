namespace Narya.Database.Sessions;

/// <summary>
/// Marten document tracking that a login has chatted during a given
/// <see cref="StreamSessionDocument"/>. Mirrors legacy's <c>stream_session_chatters</c> table
/// (composite primary key <c>(session_id, login)</c>): here the composite key is folded into a
/// single string <see cref="Id"/> (<c>"{sessionId}:{login}"</c>) since Marten documents have a
/// single identity field, not a composite one.
///
/// <para>
/// Written insert-or-ignore (see <c>StreamSessionStore.RecordCurrentSessionChatterAsync</c>) —
/// once a login is recorded for a session it is never updated or removed, so
/// <see cref="FirstMessageId"/>/<see cref="FirstSeenAt"/> are a true "first seen" watermark for
/// that session.
/// </para>
/// </summary>
public sealed record StreamSessionChatterDocument
{
  /// <summary><c>"{SessionId}:{Login}"</c> — the natural composite key, folded into Marten's single-field identity.</summary>
  public string Id { get; init; } = string.Empty;

  public string SessionId { get; init; } = string.Empty;

  /// <summary>Lowercased Twitch login.</summary>
  public string Login { get; init; } = string.Empty;

  public string FirstMessageId { get; init; } = string.Empty;

  public DateTimeOffset FirstSeenAt { get; init; }
}
