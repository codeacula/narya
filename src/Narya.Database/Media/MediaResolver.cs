using Narya.Core.Media;

namespace Narya.Database.Media;

/// <summary>
/// <see cref="IMediaResolver"/> — thin wrapper over <see cref="IMediaAssetStore.GetByIdAsync"/>
/// that applies the choke-point rule (see <see cref="IMediaResolver"/>'s doc comment). Kept as
/// its own type rather than folded into <see cref="MediaAssetStore"/> so Phase 4 Task 3's Action
/// executor can depend on the narrow <see cref="IMediaResolver"/> port alone, exactly matching
/// this interface's own "the executor never calls <see cref="IMediaAssetStore"/> directly for
/// playback" intent.
/// </summary>
public sealed class MediaResolver(IMediaAssetStore store) : IMediaResolver
{
  public async Task<MediaAsset?> ResolveForPlaybackAsync(Guid id, CancellationToken cancellationToken)
  {
    var asset = await store.GetByIdAsync(id, cancellationToken).ConfigureAwait(false);
    return asset is { Enabled: true, Available: true } ? asset : null;
  }
}
