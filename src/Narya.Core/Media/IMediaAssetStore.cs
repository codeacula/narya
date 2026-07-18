using FluentResults;

namespace Narya.Core.Media;

/// <summary>
/// Outcome of <see cref="IMediaAssetStore.DeleteAsync"/> — a port of legacy's <c>deleteMediaAsset</c>
/// 404/409/204 trichotomy (<c>legacy/src/server/mediaAssets.ts</c>).
/// </summary>
public enum MediaAssetDeleteOutcome
{
  NotFound = 0,
  Referenced = 1,
  Deleted = 2,
}

/// <summary>
/// The configured media catalog — a port of legacy's <c>mediaAssets.ts</c> store half (the route
/// half is <c>Narya.Api.Controllers.MediaAssetsController</c>). Implemented by
/// <c>Narya.Database.Media.MediaAssetStore</c>; registered
/// <c>AddSingleton&lt;IMediaAssetStore, MediaAssetStore&gt;</c> in
/// <c>Narya.Database.ServiceCollectionExtensions.AddNaryaDatabase</c> — same reference-direction
/// constraint as <c>Narya.Core.Automod.IAutomodStore</c> (defined here, not alongside its
/// implementation, so a Narya.Core-only consumer never needs to reference Narya.Database).
/// </summary>
public interface IMediaAssetStore
{
  /// <summary>Every configured asset, ordered by <see cref="MediaAsset.Label"/>.</summary>
  Task<IReadOnlyList<MediaAsset>> GetAllAsync(CancellationToken cancellationToken);

  /// <summary>The stored asset for <paramref name="id"/>, or <see langword="null"/> if none exists.</summary>
  Task<MediaAsset?> GetByIdAsync(Guid id, CancellationToken cancellationToken);

  /// <summary>
  /// Validates <paramref name="patch"/> (via <see cref="MediaAssetValidation.Normalize"/> against
  /// no current row) and inserts it. A validation failure never persists anything.
  /// </summary>
  Task<Result<MediaAsset>> CreateAsync(MediaAssetPatch patch, CancellationToken cancellationToken);

  /// <summary>
  /// Loads <paramref name="id"/>, validates <paramref name="patch"/> against it (absent fields
  /// fall back to the current stored value — see <see cref="MediaAssetPatch"/>), and saves.
  /// Returns <see langword="null"/> for an unknown <paramref name="id"/> (the caller 404s); a
  /// non-null <see cref="Result{TValue}"/> that is <c>IsFailed</c> for a validation rejection
  /// (the caller 400s, and nothing is persisted); otherwise the updated asset.
  /// </summary>
  Task<Result<MediaAsset>?> UpdateAsync(Guid id, MediaAssetPatch patch, CancellationToken cancellationToken);

  /// <summary>
  /// Hard-deletes <paramref name="id"/> unless it is still referenced by an Action's
  /// <c>play_media</c> step (<see cref="MediaAssetDeleteOutcome.Referenced"/> — a referenced
  /// asset an Action still plays would leave the step pointing at an id that no longer resolves,
  /// so it must be disabled instead of deleted).
  /// </summary>
  Task<MediaAssetDeleteOutcome> DeleteAsync(Guid id, CancellationToken cancellationToken);

  /// <summary>
  /// True when a <c>play_media</c> step on any Action still names <paramref name="id"/> in its
  /// <c>assetIds</c>. Wired in Phase 4 Task 2 against <c>Narya.Database.Actions.ActionDocument</c>
  /// — see <c>Narya.Database.Media.MediaAssetStore.IsReferencedByAnyActionAsync</c>'s doc comment
  /// for the query approach (in-memory scan, not a pushed-down JSONB predicate, and why).
  /// <c>Narya.Database.Media.MediaAssetStore.DeleteAsync</c> calls this method (not a duplicated
  /// inline check), so <c>DELETE /api/media-assets/{id}</c> now genuinely returns 409 when a
  /// referenced asset is deleted.
  /// </summary>
  Task<bool> IsReferencedByAnyActionAsync(Guid id, CancellationToken cancellationToken);
}
