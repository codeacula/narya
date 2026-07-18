namespace Narya.Core.Media;

/// <summary>
/// The Phase 4 default <see cref="IMediaFileCatalog"/> — registered via <c>TryAddSingleton</c> in
/// <c>Narya.Application.ServiceCollectionExtensions.AddNaryaApplication</c>, mirroring
/// <see cref="Narya.Core.Realtime.NullRealtimePublisher"/>/
/// <see cref="Narya.Core.Dashboard.NullDashboardTwitchStatusProvider"/>'s exact rationale: any
/// host that composes <c>AddNaryaApplication</c> — including a <c>WebApplicationFactory</c> test
/// under <c>Narya:SkipInfrastructure</c> — needs SOMETHING to resolve <see cref="IMediaFileCatalog"/>
/// the moment anything constructs <c>Narya.Database.Media.MediaAssetStore</c> (or, with
/// <c>ValidateOnBuild</c>, at host startup even if nothing ever calls it).
///
/// Every local src reports as missing/unavailable — see <see cref="IMediaFileCatalog"/>'s doc
/// comment for why this is deliberate rather than a stopgap bug: Phase 5 owns the real
/// filesystem/companion-agent-backed catalog, registered with a plain <c>AddSingleton</c> that
/// always wins over this type's <c>TryAddSingleton</c> registration. Until then, a local
/// <see cref="MediaAsset"/> simply cannot be created (every local-source validation 400s), and any
/// local asset a future migration inserts directly reports <c>Available: false</c>. Remote assets
/// are unaffected — <see cref="IsAvailable"/> for <see cref="MediaSourceType.Remote"/> is always
/// <see langword="true"/> regardless of which catalog implementation is active.
/// </summary>
public sealed class NullMediaFileCatalog : IMediaFileCatalog
{
  public bool IsAvailable(MediaSourceType sourceType, string src) => sourceType == MediaSourceType.Remote;

  public MediaKind? KindForLocalSrc(string src) => null;

  public IReadOnlyList<MediaFile> Discovered() => [];
}
