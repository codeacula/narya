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
