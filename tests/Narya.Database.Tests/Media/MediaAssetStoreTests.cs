using Marten;

using Narya.Core.Actions;
using Narya.Core.Media;
using Narya.Database.Actions;
using Narya.Database.Media;
using Narya.Database.Tests.Fixtures;

namespace Narya.Database.Tests.Media;

[Collection("postgres")]
public sealed class MediaAssetStoreTests(PostgresFixture fixture)
{
  /// <summary>
  /// A mutable stand-in for the real filesystem/companion-agent catalog Phase 5 ships — lets
  /// tests flip a src's availability AFTER a row is created, proving
  /// <see cref="MediaAsset.Available"/> is computed live at read time rather than cached at
  /// write time. Mirrors <c>Narya.Database.Tests.Automod.AutomodStoreTests.ManualTimeProvider</c>'s
  /// hand-rolled-double pattern.
  /// </summary>
  private sealed class FakeMediaFileCatalog : IMediaFileCatalog
  {
    private readonly Dictionary<string, MediaKind> _files = new(StringComparer.Ordinal);
    private readonly HashSet<string> _unavailable = new(StringComparer.Ordinal);

    public void AddFile(string src, MediaKind kind) => _files[src] = kind;

    public void MarkUnavailable(string src) => _unavailable.Add(src);

    public bool IsAvailable(MediaSourceType sourceType, string src) =>
      sourceType == MediaSourceType.Remote || (_files.ContainsKey(src) && !_unavailable.Contains(src));

    public MediaKind? KindForLocalSrc(string src) => _files.TryGetValue(src, out var kind) ? kind : null;

    public IReadOnlyList<MediaFile> Discovered() =>
      [.. _files.Select(kv => new MediaFile(kv.Key, kv.Key, kv.Value, 0))];
  }

  private async Task<IDocumentStore> BuildCleanDocumentStoreAsync()
  {
    var documentStore = fixture.CreateStore(NaryaMartenConfig.Configure);
    await documentStore.Storage.ApplyAllConfiguredChangesToDatabaseAsync();
    await documentStore.Advanced.Clean.DeleteAllEventDataAsync(CancellationToken.None);
    await documentStore.Advanced.Clean.DeleteAllDocumentsAsync(CancellationToken.None);
    return documentStore;
  }

  private static MediaAssetPatch BuildRemotePatch(string label = "Air Horn", string src = "https://example.com/air-horn.mp3") =>
    new() { Label = label, Kind = MediaKind.Audio, SourceType = MediaSourceType.Remote, Src = src };

  // ---------------------------------------------------------------------------------------
  // Create / GetAll / GetById round-trip
  // ---------------------------------------------------------------------------------------

  [Fact]
  public async Task CreateInsertsAndGetByIdReturnsIt()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new MediaAssetStore(documentStore, new FakeMediaFileCatalog(), TimeProvider.System);

    var created = await store.CreateAsync(BuildRemotePatch(), CancellationToken.None);

    Assert.True(created.IsSuccess);
    Assert.NotEqual(Guid.Empty, created.Value.Id);
    Assert.Equal("Air Horn", created.Value.Label);
    Assert.Equal(MediaKind.Audio, created.Value.Kind);
    Assert.Equal(MediaSourceType.Remote, created.Value.SourceType);
    Assert.True(created.Value.Enabled);
    Assert.True(created.Value.Available);

    var fetched = await store.GetByIdAsync(created.Value.Id, CancellationToken.None);
    Assert.NotNull(fetched);
    Assert.Equal(created.Value.Label, fetched.Label);
  }

  [Fact]
  public async Task CreateValidationFailureInsertsNothing()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new MediaAssetStore(documentStore, new FakeMediaFileCatalog(), TimeProvider.System);

    var result = await store.CreateAsync(new MediaAssetPatch(), CancellationToken.None);

    Assert.True(result.IsFailed);
    var all = await store.GetAllAsync(CancellationToken.None);
    Assert.Empty(all);
  }

  [Fact]
  public async Task GetByIdReturnsNullForAnUnknownId()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new MediaAssetStore(documentStore, new FakeMediaFileCatalog(), TimeProvider.System);

    var fetched = await store.GetByIdAsync(Guid.NewGuid(), CancellationToken.None);

    Assert.Null(fetched);
  }

  [Fact]
  public async Task GetAllIsOrderedByLabel()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new MediaAssetStore(documentStore, new FakeMediaFileCatalog(), TimeProvider.System);
    _ = await store.CreateAsync(BuildRemotePatch(label: "Zebra", src: "https://example.com/zebra.mp3"), CancellationToken.None);
    _ = await store.CreateAsync(BuildRemotePatch(label: "Apple", src: "https://example.com/apple.mp3"), CancellationToken.None);
    _ = await store.CreateAsync(BuildRemotePatch(label: "Mango", src: "https://example.com/mango.mp3"), CancellationToken.None);

    var all = await store.GetAllAsync(CancellationToken.None);

    Assert.Equal(["Apple", "Mango", "Zebra"], all.Select(a => a.Label));
  }

  // ---------------------------------------------------------------------------------------
  // Update — partial
  // ---------------------------------------------------------------------------------------

  [Fact]
  public async Task UpdateOnAnUnknownIdReturnsNull()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new MediaAssetStore(documentStore, new FakeMediaFileCatalog(), TimeProvider.System);

    var result = await store.UpdateAsync(Guid.NewGuid(), new MediaAssetPatch { Label = "New" }, CancellationToken.None);

    Assert.Null(result);
  }

  [Fact]
  public async Task UpdateWithOnlyLabelLeavesEveryOtherFieldAndBumpsUpdatedAt()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new MediaAssetStore(documentStore, new FakeMediaFileCatalog(), TimeProvider.System);
    var created = await store.CreateAsync(
      new MediaAssetPatch
      {
        Label = "Old label",
        Kind = MediaKind.Audio,
        SourceType = MediaSourceType.Remote,
        Src = "https://example.com/x.mp3",
        Volume = 0.3,
        Enabled = false,
      },
      CancellationToken.None);

    var result = await store.UpdateAsync(created.Value.Id, new MediaAssetPatch { Label = "New label" }, CancellationToken.None);

    Assert.NotNull(result);
    Assert.True(result.IsSuccess);
    Assert.Equal("New label", result.Value.Label);
    Assert.Equal("https://example.com/x.mp3", result.Value.Src);
    Assert.Equal(0.3, result.Value.Volume);
    Assert.False(result.Value.Enabled);
    Assert.True(result.Value.UpdatedAt >= created.Value.UpdatedAt);
  }

  [Fact]
  public async Task UpdateValidationFailureLeavesTheStoredRowUntouched()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new MediaAssetStore(documentStore, new FakeMediaFileCatalog(), TimeProvider.System);
    var created = await store.CreateAsync(BuildRemotePatch(), CancellationToken.None);

    var result = await store.UpdateAsync(created.Value.Id, new MediaAssetPatch { Label = "   " }, CancellationToken.None);

    Assert.NotNull(result);
    Assert.True(result.IsFailed);
    var stillThere = await store.GetByIdAsync(created.Value.Id, CancellationToken.None);
    Assert.Equal("Air Horn", stillThere!.Label);
  }

  [Fact]
  public async Task LocalSelfRepairOnUpdateAllowsResavingAMissingFile()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var catalog = new FakeMediaFileCatalog();
    catalog.AddFile("/sounds/quack.mp3", MediaKind.Audio);
    var store = new MediaAssetStore(documentStore, catalog, TimeProvider.System);
    var created = await store.CreateAsync(
      new MediaAssetPatch { Label = "Quack", Kind = MediaKind.Audio, SourceType = MediaSourceType.Local, Src = "/sounds/quack.mp3" },
      CancellationToken.None);
    Assert.True(created.IsSuccess);

    // The file disappears from the catalog entirely (not just marked unavailable) — a bare
    // GetById would now report Available: false; re-saving with only the label changed must
    // still succeed (self-repair), matching MediaAssetValidationTests' pure-logic coverage.
    var catalogWithoutFile = new FakeMediaFileCatalog();
    var storeAfterFileRemoved = new MediaAssetStore(documentStore, catalogWithoutFile, TimeProvider.System);

    var result = await storeAfterFileRemoved.UpdateAsync(
      created.Value.Id, new MediaAssetPatch { Label = "Quack (renamed)" }, CancellationToken.None);

    Assert.NotNull(result);
    Assert.True(result.IsSuccess);
    Assert.Equal("Quack (renamed)", result.Value.Label);
    Assert.Equal(MediaKind.Audio, result.Value.Kind);
  }

  // ---------------------------------------------------------------------------------------
  // Available — derived, never stored
  // ---------------------------------------------------------------------------------------

  [Fact]
  public async Task RemoteAssetIsAlwaysAvailable()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new MediaAssetStore(documentStore, new FakeMediaFileCatalog(), TimeProvider.System);

    var created = await store.CreateAsync(BuildRemotePatch(), CancellationToken.None);

    Assert.True(created.Value.Available);
  }

  [Fact]
  public async Task LocalAssetAvailabilityIsComputedLiveNotCachedAtCreateTime()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var catalog = new FakeMediaFileCatalog();
    catalog.AddFile("/sounds/quack.mp3", MediaKind.Audio);
    var store = new MediaAssetStore(documentStore, catalog, TimeProvider.System);
    var created = await store.CreateAsync(
      new MediaAssetPatch { Label = "Quack", Kind = MediaKind.Audio, SourceType = MediaSourceType.Local, Src = "/sounds/quack.mp3" },
      CancellationToken.None);
    Assert.True(created.Value.Available);

    // The file goes missing after creation — no update call, just a live catalog change.
    catalog.MarkUnavailable("/sounds/quack.mp3");

    var refetched = await store.GetByIdAsync(created.Value.Id, CancellationToken.None);
    Assert.NotNull(refetched);
    Assert.False(refetched.Available);
  }

  // ---------------------------------------------------------------------------------------
  // Delete
  // ---------------------------------------------------------------------------------------

  [Fact]
  public async Task DeleteOnAnUnknownIdReturnsNotFound()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new MediaAssetStore(documentStore, new FakeMediaFileCatalog(), TimeProvider.System);

    var outcome = await store.DeleteAsync(Guid.NewGuid(), CancellationToken.None);

    Assert.Equal(MediaAssetDeleteOutcome.NotFound, outcome);
  }

  [Fact]
  public async Task DeleteOnAnUnreferencedAssetRemovesItAndReturnsDeleted()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new MediaAssetStore(documentStore, new FakeMediaFileCatalog(), TimeProvider.System);
    var created = await store.CreateAsync(BuildRemotePatch(), CancellationToken.None);

    var outcome = await store.DeleteAsync(created.Value.Id, CancellationToken.None);

    Assert.Equal(MediaAssetDeleteOutcome.Deleted, outcome);
    var fetched = await store.GetByIdAsync(created.Value.Id, CancellationToken.None);
    Assert.Null(fetched);
  }

  /// <summary>
  /// Inserts a minimal <see cref="ActionDocument"/> with a single <c>play_media</c> step directly
  /// via a Marten session — a hand-rolled fixture rather than going through
  /// <c>Narya.Database.Actions.ActionStore</c>, so this test file does not need to depend on the
  /// Actions store's own validation/normalization to set up its scenario.
  /// </summary>
  private static async Task InsertActionReferencingAssetAsync(IDocumentStore documentStore, Guid assetId)
  {
    await using var session = documentStore.LightweightSession();
    session.Insert(new ActionDocument
    {
      Id = Guid.NewGuid(),
      Name = $"References {assetId}",
      Enabled = true,
      Steps =
      [
        new PlayMediaActionStep
        {
          Id = Guid.NewGuid(),
          Position = 0,
          AssetIds = [assetId],
          Selection = MediaSelection.First,
        },
      ],
      CreatedAt = DateTimeOffset.UtcNow,
      UpdatedAt = DateTimeOffset.UtcNow,
    });
    await session.SaveChangesAsync(CancellationToken.None);
  }

  /// <summary>
  /// Phase 4 Task 1 stubbed <see cref="IMediaAssetStore.IsReferencedByAnyActionAsync"/> to always
  /// return <see langword="false"/> because <see cref="ActionDocument"/> didn't exist yet. This
  /// is that deferred test, now that it does: an Action with a <c>play_media</c> step whose
  /// <c>assetIds</c> names this asset makes the check true.
  /// </summary>
  [Fact]
  public async Task IsReferencedByAnyActionIsTrueWhenAPlayMediaStepNamesTheAsset()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new MediaAssetStore(documentStore, new FakeMediaFileCatalog(), TimeProvider.System);
    var created = await store.CreateAsync(BuildRemotePatch(), CancellationToken.None);
    await InsertActionReferencingAssetAsync(documentStore, created.Value.Id);

    var referenced = await store.IsReferencedByAnyActionAsync(created.Value.Id, CancellationToken.None);

    Assert.True(referenced);
  }

  [Fact]
  public async Task IsReferencedByAnyActionIsFalseWhenNoStepNamesTheAsset()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new MediaAssetStore(documentStore, new FakeMediaFileCatalog(), TimeProvider.System);
    var created = await store.CreateAsync(BuildRemotePatch(), CancellationToken.None);
    // An action exists, but references a DIFFERENT asset entirely.
    await InsertActionReferencingAssetAsync(documentStore, Guid.NewGuid());

    var referenced = await store.IsReferencedByAnyActionAsync(created.Value.Id, CancellationToken.None);

    Assert.False(referenced);
  }

  /// <summary>
  /// Completes Phase 4 Task 1's deferred coverage: <c>DELETE /api/media-assets/{id}</c> (here,
  /// the store method behind it) now genuinely returns <see cref="MediaAssetDeleteOutcome.Referenced"/>
  /// instead of always succeeding, now that there is an Action to reference it.
  /// </summary>
  [Fact]
  public async Task DeleteOnAReferencedAssetReturnsReferencedAndDoesNotDeleteIt()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new MediaAssetStore(documentStore, new FakeMediaFileCatalog(), TimeProvider.System);
    var created = await store.CreateAsync(BuildRemotePatch(), CancellationToken.None);
    await InsertActionReferencingAssetAsync(documentStore, created.Value.Id);

    var outcome = await store.DeleteAsync(created.Value.Id, CancellationToken.None);

    Assert.Equal(MediaAssetDeleteOutcome.Referenced, outcome);
    var stillThere = await store.GetByIdAsync(created.Value.Id, CancellationToken.None);
    Assert.NotNull(stillThere);
  }
}
