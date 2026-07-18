using FluentResults;

using Marten;

using Narya.Core.Actions;
using Narya.Core.Media;
using Narya.Database.Actions;

namespace Narya.Database.Media;

/// <summary>
/// <see cref="IMediaAssetStore"/> backed by the plain (non-event-sourced)
/// <see cref="MediaAssetDocument"/> — mirrors legacy's <c>mediaAssets.ts</c>.
///
/// <para>
/// <b>Validation lives in <c>Narya.Core.Media.MediaAssetValidation</c>, not here.</b> This store's
/// job is: load whatever <c>current</c> row validation needs, call
/// <see cref="MediaAssetValidation.Normalize"/>, and persist the result — it never duplicates the
/// normalize/validate rules themselves. <see cref="IMediaFileCatalog"/> is injected once and
/// threaded through both validation (kind/availability checks) and every read (computing
/// <see cref="MediaAsset.Available"/>), so a single catalog instance's view of "what's on disk"
/// is consistent within one call.
/// </para>
/// </summary>
public sealed class MediaAssetStore(IDocumentStore store, IMediaFileCatalog catalog, TimeProvider timeProvider) : IMediaAssetStore
{
  public async Task<IReadOnlyList<MediaAsset>> GetAllAsync(CancellationToken cancellationToken)
  {
    await using var session = store.QuerySession();
    var docs = await session.Query<MediaAssetDocument>().ToListAsync(cancellationToken);
    return [.. docs.Select(ToAsset).OrderBy(a => a.Label, StringComparer.Ordinal)];
  }

  public async Task<MediaAsset?> GetByIdAsync(Guid id, CancellationToken cancellationToken)
  {
    await using var session = store.QuerySession();
    var doc = await session.LoadAsync<MediaAssetDocument>(id, cancellationToken);
    return doc is null ? null : ToAsset(doc);
  }

  public async Task<Result<MediaAsset>> CreateAsync(MediaAssetPatch patch, CancellationToken cancellationToken)
  {
    var normalized = MediaAssetValidation.Normalize(patch, current: null, catalog);
    if (normalized.IsFailed)
    {
      return Result.Fail<MediaAsset>(normalized.Errors);
    }

    var now = timeProvider.GetUtcNow();
    var doc = new MediaAssetDocument
    {
      Id = Guid.NewGuid(),
      Label = normalized.Value.Label,
      Kind = KindToString(normalized.Value.Kind),
      SourceType = SourceTypeToString(normalized.Value.SourceType),
      Src = normalized.Value.Src,
      Volume = normalized.Value.Volume,
      Enabled = normalized.Value.Enabled,
      CreatedAt = now,
      UpdatedAt = now,
    };

    await using var session = store.LightweightSession();
    session.Insert(doc);
    await session.SaveChangesAsync(cancellationToken);

    return Result.Ok(ToAsset(doc));
  }

  public async Task<Result<MediaAsset>?> UpdateAsync(Guid id, MediaAssetPatch patch, CancellationToken cancellationToken)
  {
    await using var session = store.LightweightSession();
    var existing = await session.LoadAsync<MediaAssetDocument>(id, cancellationToken);
    if (existing is null)
    {
      return null;
    }

    var normalized = MediaAssetValidation.Normalize(patch, ToAsset(existing), catalog);
    if (normalized.IsFailed)
    {
      return Result.Fail<MediaAsset>(normalized.Errors);
    }

    var updated = existing with
    {
      Label = normalized.Value.Label,
      Kind = KindToString(normalized.Value.Kind),
      SourceType = SourceTypeToString(normalized.Value.SourceType),
      Src = normalized.Value.Src,
      Volume = normalized.Value.Volume,
      Enabled = normalized.Value.Enabled,
      UpdatedAt = timeProvider.GetUtcNow(),
    };

    session.Store(updated);
    await session.SaveChangesAsync(cancellationToken);

    return Result.Ok(ToAsset(updated));
  }

  public async Task<MediaAssetDeleteOutcome> DeleteAsync(Guid id, CancellationToken cancellationToken)
  {
    await using var session = store.LightweightSession();
    var existing = await session.LoadAsync<MediaAssetDocument>(id, cancellationToken);
    if (existing is null)
    {
      return MediaAssetDeleteOutcome.NotFound;
    }

    if (await IsReferencedByAnyActionAsync(id, cancellationToken).ConfigureAwait(false))
    {
      return MediaAssetDeleteOutcome.Referenced;
    }

    session.Delete<MediaAssetDocument>(id);
    await session.SaveChangesAsync(cancellationToken);
    return MediaAssetDeleteOutcome.Deleted;
  }

  /// <summary>
  /// Wired against <see cref="ActionDocument"/> (Phase 4 Task 2 — was stubbed to always return
  /// <see langword="false"/> in Task 1, since <see cref="ActionDocument"/> didn't exist yet).
  ///
  /// Loads every Action and checks its embedded steps in memory rather than pushing the
  /// predicate into a Marten/Postgres JSONB query: the check is "does any ActionDocument have a
  /// <c>play_media</c> step whose <c>AssetIds</c> contains this id", which needs Marten's LINQ
  /// provider to translate a nested-collection `Any` over a POLYMORPHIC element type (filter by
  /// runtime subtype, then by a property that only exists on that subtype) into SQL — a
  /// combination Marten's computed-index/query translation is not documented to support for
  /// arbitrarily-shaped JSONB array elements. The configured Actions catalog is operator-sized
  /// (tens, not millions, of rows — the same order of magnitude as
  /// <see cref="MediaAssetStore.GetAllAsync"/>'s own full-table load), so an in-memory scan is the
  /// safe, correct choice here; if the catalog ever grows enough for this to matter, revisit with
  /// a real SQL-side query.
  /// </summary>
  public async Task<bool> IsReferencedByAnyActionAsync(Guid id, CancellationToken cancellationToken)
  {
    await using var session = store.QuerySession();
    var actions = await session.Query<ActionDocument>().ToListAsync(cancellationToken);
    return actions.Any(action => action.Steps
      .OfType<PlayMediaActionStep>()
      .Any(step => step.AssetIds.Contains(id)));
  }

  private MediaAsset ToAsset(MediaAssetDocument doc)
  {
    var kind = StringToKind(doc.Kind);
    var sourceType = StringToSourceType(doc.SourceType);
    return new MediaAsset(
      Id: doc.Id,
      Label: doc.Label,
      Kind: kind,
      SourceType: sourceType,
      Src: doc.Src,
      Volume: doc.Volume,
      Enabled: doc.Enabled,
      Available: catalog.IsAvailable(sourceType, doc.Src),
      CreatedAt: doc.CreatedAt,
      UpdatedAt: doc.UpdatedAt);
  }

  private static string KindToString(MediaKind kind) => kind switch
  {
    MediaKind.Audio => "audio",
    MediaKind.Video => "video",
    _ => throw new ArgumentOutOfRangeException(nameof(kind), kind, "Unknown media kind."),
  };

  private static MediaKind StringToKind(string value) => value switch
  {
    "audio" => MediaKind.Audio,
    "video" => MediaKind.Video,
    _ => throw new InvalidOperationException($"Unknown stored media kind '{value}'."),
  };

  private static string SourceTypeToString(MediaSourceType sourceType) => sourceType switch
  {
    MediaSourceType.Local => "local",
    MediaSourceType.Remote => "remote",
    _ => throw new ArgumentOutOfRangeException(nameof(sourceType), sourceType, "Unknown media source type."),
  };

  private static MediaSourceType StringToSourceType(string value) => value switch
  {
    "local" => MediaSourceType.Local,
    "remote" => MediaSourceType.Remote,
    _ => throw new InvalidOperationException($"Unknown stored media source type '{value}'."),
  };
}
