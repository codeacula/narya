using Narya.Core.Sessions;

namespace Narya.Database.Sessions;

/// <summary>
/// Marten document backing <see cref="StreamSession"/>. Deliberately a plain, mutable
/// document — not an event-sourced aggregate like <c>DbAppConfig</c>/<c>DbTwitchToken</c> —
/// because a stream session's access pattern is query-heavy ("find the active one", "dedup on
/// source", "force-close whatever is open") and it has few transitions (open → closed, plus
/// Phase 8's Discord bookkeeping fields), so event-sourcing would add ceremony without benefit.
/// See <c>StreamSessionStore</c>'s doc comment for the write-side invariant this backs.
///
/// <para>
/// Must be public — Marten generates document-storage code at runtime and a private/internal
/// document type fails storage codegen (the same lesson <c>MartenSmokeTests.Doc</c> documents).
/// </para>
///
/// <para><see cref="Id"/> is a plain <c>Guid.NewGuid().ToString()</c>, assigned by the store on
/// insert — Marten's string-identity documents require the caller to assign an id rather than
/// auto-generating one, unlike its Guid/int/long identity strategies.</para>
/// </summary>
public sealed record StreamSessionDocument
{
  public string Id { get; init; } = string.Empty;

  public DateTimeOffset StartedAt { get; init; }

  public DateTimeOffset? EndedAt { get; init; }

  /// <summary>Natural key a caller dedups on, e.g. <c>"twitch:{streamId}"</c>. See <see cref="StreamSession.Source"/>.</summary>
  public string Source { get; init; } = string.Empty;

  public string? DiscordMessageId { get; init; }

  public string? DiscordChannelId { get; init; }

  public string? DiscordAnnounceError { get; init; }

  public int DiscordAnnounceAttempts { get; init; }

  public bool DiscordAnnounceTerminal { get; init; }

  /// <summary>
  /// The one-active-session invariant, expressed as something a database can enforce: the constant
  /// <c>"open"</c> while <see cref="EndedAt"/> is null, and null once the session ends. A PARTIAL
  /// UNIQUE index over it (unique where non-null — see <c>NaryaMartenConfig</c>) therefore means
  /// "at most one open session may exist," which no index over <see cref="EndedAt"/> itself could
  /// say (many CLOSED sessions are legal, so <c>EndedAt</c> cannot be unique).
  ///
  /// <para>
  /// Deliberately COMPUTED from <see cref="EndedAt"/> rather than a settable field: a settable one
  /// could be forgotten at any write site that ends a session and would then silently disarm the
  /// constraint. It is get-only, so it is serialized into the document JSON (where the index reads
  /// it) and ignored on deserialization — nothing round-trips it, and it can never disagree with
  /// <see cref="EndedAt"/>.
  /// </para>
  /// </summary>
  public string? OpenMarker => EndedAt is null ? "open" : null;

  public static explicit operator StreamSession(StreamSessionDocument doc)
  {
    return new StreamSession(
      doc.Id,
      doc.StartedAt,
      doc.EndedAt,
      doc.Source,
      doc.DiscordMessageId,
      doc.DiscordChannelId,
      doc.DiscordAnnounceError,
      doc.DiscordAnnounceAttempts,
      doc.DiscordAnnounceTerminal);
  }
}
