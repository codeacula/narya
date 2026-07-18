namespace Narya.Core.Sessions;

/// <summary>
/// A single stream broadcast, tracked from <c>stream.online</c> to <c>stream.offline</c>.
/// Mirrors legacy's <c>StreamSession</c> (<c>legacy/src/server/streamSession.ts</c>).
///
/// <para>
/// <see cref="Source"/> is the natural key a caller dedups on — <c>"twitch:{streamId}"</c> for
/// the only source that exists so far — so a redelivered <c>stream.online</c> for the same
/// broadcast reuses the same row instead of opening a second session.
/// </para>
///
/// <para>
/// The four <c>DiscordAnnounce*</c>/<c>DiscordMessageId</c>/<c>DiscordChannelId</c> fields are
/// bookkeeping columns for the Phase 8 go-live announcement flow — present now so that flow
/// does not need a schema change later, but unused (always default) until then.
/// </para>
/// </summary>
public sealed record StreamSession(
  string Id,
  DateTimeOffset StartedAt,
  DateTimeOffset? EndedAt,
  string Source,
  string? DiscordMessageId,
  string? DiscordChannelId,
  string? DiscordAnnounceError,
  int DiscordAnnounceAttempts,
  bool DiscordAnnounceTerminal);

/// <summary>
/// Result of <see cref="IStreamSessionStore.RecordCurrentSessionChatterAsync"/> — mirrors
/// legacy's <c>{ sessionId, isFirstInSession }</c> return shape. <see cref="SessionId"/> is
/// null when there is no active session to record against (off-stream chat); in that case
/// <see cref="IsFirstInSession"/> is always false.
/// </summary>
public sealed record SessionChatterResult(string? SessionId, bool IsFirstInSession);
