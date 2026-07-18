namespace Narya.Core.Media;

/// <summary>
/// A playable file discovered under the server's served media roots (legacy:
/// <c>public/clips</c>/<c>public/sounds</c>) — a port of legacy's <c>MediaFile</c>
/// (<c>legacy/src/shared/api.ts</c>). Surfaced only via <see cref="IMediaFileCatalog.Discovered"/>
/// / <c>GET /api/media/discovered</c>, the Content settings picker's raw-scan view — everything
/// else references a configured <see cref="MediaAsset.Id"/>, never a raw <see cref="Src"/>.
/// </summary>
public sealed record MediaFile(string Src, string Label, MediaKind Kind, long SizeBytes);

/// <summary>
/// <c>GET /api/media/discovered</c> — a port of legacy's <c>DiscoveredMediaResponse</c>.
/// <see cref="Files"/> is the raw scan (<see cref="IMediaFileCatalog.Discovered"/>);
/// <see cref="ConfiguredSrcs"/> is computed by the caller from the local
/// <see cref="MediaAsset"/>s already in the catalog (legacy's <c>mediaAssets.ts</c> route
/// handler does the same composition — the file-catalog port itself has no notion of "already
/// claimed by an asset", only the asset store does), so the picker can mark files already in use.
/// </summary>
public sealed record MediaDiscovery(IReadOnlyList<MediaFile> Files, IReadOnlyList<string> ConfiguredSrcs);
