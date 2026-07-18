namespace Narya.Core.Media;

/// <summary>
/// THE single choke point for media playback — a port of legacy's
/// <c>resolveMediaAssetForPlayback</c> (<c>legacy/src/server/mediaAssets.ts</c>). Every path that
/// would emit a <c>media:play</c> broadcast resolves the asset here first, so a disabled asset or
/// one whose file has gone missing can never reach an overlay. Phase 4 Task 3's Action executor
/// takes this as an injected port (never calling <see cref="IMediaAssetStore"/> directly for
/// playback) — matches this interface's own doc-comment intent and keeps the executor testable
/// without a document store.
///
/// Implemented by <c>Narya.Database.Media.MediaResolver</c>; registered
/// <c>AddSingleton&lt;IMediaResolver, MediaResolver&gt;</c> in
/// <c>Narya.Database.ServiceCollectionExtensions.AddNaryaDatabase</c>.
/// </summary>
public interface IMediaResolver
{
  /// <summary>
  /// <see langword="null"/> if <paramref name="id"/> is unknown, <c>!Enabled</c>, or
  /// <c>!Available</c>; otherwise the playable asset.
  /// </summary>
  Task<MediaAsset?> ResolveForPlaybackAsync(Guid id, CancellationToken cancellationToken);
}
