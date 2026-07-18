namespace Narya.Core.Media;

/// <summary>
/// An operator-configured playable asset — a port of legacy's <c>MediaAsset</c>
/// (<c>legacy/src/shared/api.ts</c>). This is the ONLY thing rewards, Actions, commands, and
/// tablet controls may reference once Phase 4's Actions/triggers land; raw filesystem entries
/// (<see cref="MediaFile"/>) appear solely in the Content settings picker when adding an asset.
///
/// <see cref="Available"/> is DERIVED at read time, never stored: a local asset whose file has
/// gone missing stays in the catalog (so it can be repaired) but reports <c>Available: false</c>
/// and — via <see cref="IMediaResolver"/>, the single playback choke point — never reaches an
/// overlay. A remote asset is always available; the server never dials out to check.
/// </summary>
public sealed record MediaAsset(
  Guid Id,
  string Label,
  MediaKind Kind,
  MediaSourceType SourceType,
  string Src,
  double Volume,
  bool Enabled,
  bool Available,
  DateTimeOffset CreatedAt,
  DateTimeOffset UpdatedAt);

/// <summary>GET /api/media-assets — a port of legacy's <c>MediaAssetsResponse</c>.</summary>
public sealed record MediaAssetsResponse(IReadOnlyList<MediaAsset> Assets);
