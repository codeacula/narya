namespace Narya.Core.Media;

/// <summary>
/// The request body for both <c>POST /api/media-assets</c> and <c>PUT /api/media-assets/{id}</c>
/// — a port of legacy's <c>Partial&lt;MediaAssetInput&gt;</c> body handling
/// (<c>legacy/src/server/mediaAssets.ts</c>'s <c>normalize</c>). Every field is nullable with
/// "absent = fall back" semantics, resolved by <see cref="MediaAssetValidation.Normalize"/>:
/// on a PUT, an absent field falls back to the current stored value; on a POST (no current row),
/// an absent field either has a code-literal default (<see cref="Volume"/> 0.8,
/// <see cref="Enabled"/> true) or is rejected (<see cref="Label"/>/<see cref="SourceType"/>/
/// <see cref="Src"/>/<see cref="Kind"/> are required on create).
/// </summary>
public sealed record MediaAssetPatch
{
  public string? Label { get; init; }
  public MediaKind? Kind { get; init; }
  public MediaSourceType? SourceType { get; init; }
  public string? Src { get; init; }
  public double? Volume { get; init; }
  public bool? Enabled { get; init; }
}

/// <summary>
/// The fully-resolved values <see cref="MediaAssetValidation.Normalize"/> produces from a
/// <see cref="MediaAssetPatch"/> — ready to persist. A port of legacy's <c>MediaAssetInput</c>.
/// </summary>
public sealed record MediaAssetInput(
  string Label, MediaKind Kind, MediaSourceType SourceType, string Src, double Volume, bool Enabled);
