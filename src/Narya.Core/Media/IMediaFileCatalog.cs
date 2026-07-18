namespace Narya.Core.Media;

/// <summary>
/// The authoritative source of truth for what a <see cref="MediaSourceType.Local"/> src actually
/// is on disk — a port of legacy's <c>media.ts</c> scan (<c>findMediaFile</c>/<c>listMediaFiles</c>).
///
/// <b>Phase 4/5 split (see <c>docs/superpowers/plans/2026-07-18-phase-4-automation-platform.md</c>
/// "Media storage decision"):</b> local media file STORAGE + serving is a streamer-PC-local
/// concern deferred to Phase 5 (server-side storage / companion agent). This port exists so
/// Phase 4 can model the catalog + the resolution choke point against an authoritative interface
/// now, without local availability ever degrading to a regex/pattern check. <see cref="NullMediaFileCatalog"/>
/// is the ONLY implementation Phase 4 ships (registered via <c>TryAddSingleton</c> in
/// <c>Narya.Application.ServiceCollectionExtensions.AddNaryaApplication</c>) — it reports every
/// local src as unavailable/unknown-kind, so a local asset cannot actually be created until
/// Phase 5 registers a real implementation with a plain <c>AddSingleton</c> (which always wins
/// over this port's <c>TryAddSingleton</c> default — the same last-registration-wins mechanic
/// <see cref="Narya.Core.Dashboard.NullDashboardTwitchStatusProvider"/> documents). Remote assets
/// are unaffected either way — <see cref="IsAvailable"/> for a remote src never depends on this.
/// </summary>
public interface IMediaFileCatalog
{
  /// <summary>
  /// Derived availability, never trusted from stored state: <see cref="MediaSourceType.Remote"/>
  /// is always <see langword="true"/> (the server never dials out to check); a
  /// <see cref="MediaSourceType.Local"/> src is available only while it is still in the live
  /// scan of the served media roots.
  /// </summary>
  bool IsAvailable(MediaSourceType sourceType, string src);

  /// <summary>
  /// The actual kind of a local file on disk, or <see langword="null"/> if the src is not
  /// currently served. Used for validation ONLY — a declared kind that disagrees with this is
  /// rejected (legacy: <c>${src} is ${file.kind}, not ${declaredKind}.</c>) so the overlay can
  /// never be told to play an mp3 in a <c>&lt;video&gt;</c> element.
  /// </summary>
  MediaKind? KindForLocalSrc(string src);

  /// <summary>
  /// Every playable file currently served — the raw scan backing the Content settings picker
  /// (<c>GET /api/media/discovered</c>'s <c>files</c>). A port of legacy's <c>listMediaFiles()</c>;
  /// deliberately does NOT know which files a configured <see cref="MediaAsset"/> already
  /// claims — see <see cref="MediaDiscovery"/>'s doc comment for why that composition happens
  /// one layer up.
  /// </summary>
  IReadOnlyList<MediaFile> Discovered();
}
