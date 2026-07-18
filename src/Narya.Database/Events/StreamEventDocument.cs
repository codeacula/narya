namespace Narya.Database.Events;

/// <summary>
/// The <c>stream_events</c> projection — a port of legacy's table (<c>legacy/src/server/db.ts</c>).
/// <see cref="Id"/> is the domain <see cref="Narya.Core.Events.StreamEvent.Id"/> itself (a fresh
/// guid, or the Twitch redemption id for a redeem — see that field's doc comment), not a
/// synthetic identifier — the natural key <c>Narya.Database.Events.StreamEventStore.InsertAsync</c>
/// dedups a redelivery against.
///
/// <para>
/// Must be public — Marten generates document-storage code at runtime and a private/internal
/// document type fails storage codegen (the same lesson <c>MartenSmokeTests.Doc</c> documents).
/// </para>
///
/// No <c>Ago</c> column: <see cref="Narya.Core.Events.StreamEvent.Ago"/> is wire-only, computed
/// at read time from <see cref="ReceivedAt"/> — persisting it would go stale the instant time
/// passes.
/// </summary>
public sealed record StreamEventDocument
{
  public string Id { get; init; } = string.Empty;

  public string Kind { get; init; } = string.Empty;

  /// <summary>Twitch display name shown on screen.</summary>
  public string Actor { get; init; } = string.Empty;

  public string Detail { get; init; } = string.Empty;

  public string Tone { get; init; } = string.Empty;

  public DateTimeOffset ReceivedAt { get; init; }

  /// <summary>The stream session active when the event was recorded; null off-stream or for rows predating session tracking.</summary>
  public string? SessionId { get; init; }

  /// <summary>Twitch login (lowercased) of the actor, when known — addresses the viewer, unlike <see cref="Actor"/>.</summary>
  public string? ActorLogin { get; init; }
}
