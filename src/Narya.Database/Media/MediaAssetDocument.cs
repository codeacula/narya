namespace Narya.Database.Media;

/// <summary>
/// The <c>media_assets</c> projection — a plain (non-event-sourced) document, a port of legacy's
/// table (<c>legacy/src/server/db.ts</c>). <see cref="Kind"/>/<see cref="SourceType"/> are stored
/// as their lowercase legacy string literals ("audio"/"video", "local"/"remote") rather than the
/// <c>Narya.Core.Media.MediaKind</c>/<c>MediaSourceType</c> enum types directly — matching
/// <c>Narya.Database.Automod.AutomodHoldDocument.Resolution</c>'s precedent of storing an
/// enum-shaped value as a plain string — so the document's on-disk shape never depends on
/// whichever JSON serializer Marten happens to use for enums. <c>Narya.Database.Media.MediaAssetStore</c>
/// is the only place that converts between the two. <see cref="MediaAsset.Available"/> (Core) is
/// deliberately absent here — it is derived from <c>IMediaFileCatalog</c> at read time, never
/// stored.
///
/// <para>
/// Must be public — Marten generates document-storage code at runtime and a private/internal
/// document type fails storage codegen (the same lesson <c>MartenSmokeTests.Doc</c> documents).
/// </para>
/// </summary>
public sealed record MediaAssetDocument
{
  public Guid Id { get; init; }

  public string Label { get; init; } = string.Empty;

  /// <summary>"audio" or "video" — see this type's doc comment for why this is a plain string.</summary>
  public string Kind { get; init; } = string.Empty;

  /// <summary>"local" or "remote" — see this type's doc comment for why this is a plain string.</summary>
  public string SourceType { get; init; } = string.Empty;

  public string Src { get; init; } = string.Empty;

  public double Volume { get; init; }

  public bool Enabled { get; init; }

  public DateTimeOffset CreatedAt { get; init; }

  public DateTimeOffset UpdatedAt { get; init; }
}
