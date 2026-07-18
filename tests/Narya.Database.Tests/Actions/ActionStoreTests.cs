using Marten;

using Narya.Core.Actions;
using Narya.Database.Actions;
using Narya.Database.Tests.Fixtures;

namespace Narya.Database.Tests.Actions;

[Collection("postgres")]
public sealed class ActionStoreTests(PostgresFixture fixture)
{
  private async Task<IDocumentStore> BuildCleanDocumentStoreAsync()
  {
    var documentStore = fixture.CreateStore(NaryaMartenConfig.Configure);
    await documentStore.Storage.ApplyAllConfiguredChangesToDatabaseAsync();
    await documentStore.Advanced.Clean.DeleteAllEventDataAsync(CancellationToken.None);
    await documentStore.Advanced.Clean.DeleteAllDocumentsAsync(CancellationToken.None);
    return documentStore;
  }

  private static ActionUpsert BuildUpsert(string name = "Hype Train", params ActionStep[] steps) => new()
  {
    Name = name,
    Description = "Plays a clip and shouts.",
    Steps = steps.Length == 0 ? [new ObsTransitionActionStep()] : steps,
  };

  // ---------------------------------------------------------------------------------------
  // Create / GetAll / GetById round-trip, with embedded typed steps
  // ---------------------------------------------------------------------------------------

  [Fact]
  public async Task CreateInsertsAndGetByIdReturnsItWithStepsInPositionOrder()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new ActionStore(documentStore, TimeProvider.System);
    var assetId = Guid.NewGuid();

    var created = await store.CreateAsync(
      BuildUpsert(
        steps:
        [
          new ShowTextActionStep { Template = "Hype!", Style = TextStyle.Banner, DurationMs = 3_000 },
          new PlayMediaActionStep { AssetIds = [assetId], Selection = MediaSelection.First },
          new TwitchShoutoutActionStep { LoginTemplate = "{arg1}" },
        ]),
      CancellationToken.None);

    Assert.True(created.IsSuccess);
    Assert.NotEqual(Guid.Empty, created.Value.Id);
    Assert.Equal("Hype Train", created.Value.Name);
    Assert.True(created.Value.Enabled);
    Assert.Equal(3, created.Value.Steps.Count);

    var fetched = await store.GetByIdAsync(created.Value.Id, CancellationToken.None);
    Assert.NotNull(fetched);
    Assert.Equal(3, fetched.Steps.Count);
    Assert.Equal([0, 1, 2], fetched.Steps.Select(s => s.Position));
    var showText = Assert.IsType<ShowTextActionStep>(fetched.Steps[0]);
    Assert.Equal("Hype!", showText.Template);
    var playMedia = Assert.IsType<PlayMediaActionStep>(fetched.Steps[1]);
    Assert.Equal([assetId], playMedia.AssetIds);
    var shoutout = Assert.IsType<TwitchShoutoutActionStep>(fetched.Steps[2]);
    Assert.Equal("{arg1}", shoutout.LoginTemplate);

    // Every step gets a fresh id on save — see ActionStore.AssignStepIdentity's doc comment.
    Assert.All(fetched.Steps, s => Assert.NotEqual(Guid.Empty, s.Id));
  }

  [Fact]
  public async Task CreateValidationFailureInsertsNothing()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new ActionStore(documentStore, TimeProvider.System);

    var result = await store.CreateAsync(new ActionUpsert { Name = "" }, CancellationToken.None);

    Assert.True(result.IsFailed);
    var all = await store.GetAllAsync(CancellationToken.None);
    Assert.Empty(all);
  }

  [Fact]
  public async Task GetByIdReturnsNullForAnUnknownId()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new ActionStore(documentStore, TimeProvider.System);

    var fetched = await store.GetByIdAsync(Guid.NewGuid(), CancellationToken.None);

    Assert.Null(fetched);
  }

  [Fact]
  public async Task GetAllIsOrderedByNameCaseInsensitive()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new ActionStore(documentStore, TimeProvider.System);
    _ = await store.CreateAsync(BuildUpsert("zebra action"), CancellationToken.None);
    _ = await store.CreateAsync(BuildUpsert("Apple Action"), CancellationToken.None);
    _ = await store.CreateAsync(BuildUpsert("Mango Action"), CancellationToken.None);

    var all = await store.GetAllAsync(CancellationToken.None);

    Assert.Equal(["Apple Action", "Mango Action", "zebra action"], all.Select(a => a.Name));
  }

  // ---------------------------------------------------------------------------------------
  // Update — full replace, delete-all-reinsert semantics on Steps
  // ---------------------------------------------------------------------------------------

  [Fact]
  public async Task UpdateOnAnUnknownIdReturnsNull()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new ActionStore(documentStore, TimeProvider.System);

    var result = await store.UpdateAsync(Guid.NewGuid(), BuildUpsert(), CancellationToken.None);

    Assert.Null(result);
  }

  [Fact]
  public async Task UpdateWithANewStepsListReplacesTheOldStepsEntirely()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new ActionStore(documentStore, TimeProvider.System);
    var created = await store.CreateAsync(
      BuildUpsert(steps:
      [
        new ShowTextActionStep { Template = "one", Style = TextStyle.Banner },
        new ShowTextActionStep { Template = "two", Style = TextStyle.Toast },
        new ShowTextActionStep { Template = "three", Style = TextStyle.Centered },
      ]),
      CancellationToken.None);
    Assert.True(created.IsSuccess);
    var originalStepIds = created.Value.Steps.Select(s => s.Id).ToHashSet();

    var updated = await store.UpdateAsync(
      created.Value.Id,
      BuildUpsert(steps: [new TtsSpeakActionStep { Template = "only one now" }]),
      CancellationToken.None);

    Assert.NotNull(updated);
    Assert.True(updated.IsSuccess);
    _ = Assert.Single(updated.Value.Steps);
    var remaining = Assert.IsType<TtsSpeakActionStep>(updated.Value.Steps[0]);
    Assert.Equal("only one now", remaining.Template);
    Assert.DoesNotContain(remaining.Id, originalStepIds); // old step ids are gone, not reused

    var refetched = await store.GetByIdAsync(created.Value.Id, CancellationToken.None);
    Assert.NotNull(refetched);
    _ = Assert.Single(refetched.Steps);
  }

  [Fact]
  public async Task UpdateValidationFailureLeavesTheStoredRowUntouched()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new ActionStore(documentStore, TimeProvider.System);
    var created = await store.CreateAsync(BuildUpsert(), CancellationToken.None);

    var result = await store.UpdateAsync(created.Value.Id, new ActionUpsert { Name = "" }, CancellationToken.None);

    Assert.NotNull(result);
    Assert.True(result.IsFailed);
    var stillThere = await store.GetByIdAsync(created.Value.Id, CancellationToken.None);
    Assert.Equal("Hype Train", stillThere!.Name);
  }

  [Fact]
  public async Task UpdateBumpsUpdatedAtButPreservesCreatedAt()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new ActionStore(documentStore, TimeProvider.System);
    var created = await store.CreateAsync(BuildUpsert(), CancellationToken.None);

    var updated = await store.UpdateAsync(created.Value.Id, BuildUpsert(name: "Hype Train Renamed"), CancellationToken.None);

    Assert.NotNull(updated);
    Assert.True(updated.IsSuccess);
    Assert.Equal("Hype Train Renamed", updated.Value.Name);
    Assert.Equal(created.Value.CreatedAt, updated.Value.CreatedAt);
    Assert.True(updated.Value.UpdatedAt >= created.Value.UpdatedAt);
  }

  // ---------------------------------------------------------------------------------------
  // Name uniqueness — case-insensitive, via the real Postgres unique index
  // ---------------------------------------------------------------------------------------

  [Fact]
  public async Task CreatingADuplicateNameCaseInsensitiveFails409Style()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new ActionStore(documentStore, TimeProvider.System);
    var first = await store.CreateAsync(BuildUpsert("Hype"), CancellationToken.None);
    Assert.True(first.IsSuccess);

    var second = await store.CreateAsync(BuildUpsert("hype"), CancellationToken.None);

    Assert.True(second.IsFailed);
    Assert.True(second.HasError<DuplicateActionNameError>());
    var all = await store.GetAllAsync(CancellationToken.None);
    _ = Assert.Single(all); // the failed insert did not leave a row behind
  }

  [Fact]
  public async Task UpdatingToACollidingNameCaseInsensitiveFails()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new ActionStore(documentStore, TimeProvider.System);
    _ = await store.CreateAsync(BuildUpsert("Hype"), CancellationToken.None);
    var second = await store.CreateAsync(BuildUpsert("Other"), CancellationToken.None);
    Assert.True(second.IsSuccess);

    var result = await store.UpdateAsync(second.Value.Id, BuildUpsert("HYPE"), CancellationToken.None);

    Assert.NotNull(result);
    Assert.True(result.IsFailed);
    Assert.True(result.HasError<DuplicateActionNameError>());
    var stillThere = await store.GetByIdAsync(second.Value.Id, CancellationToken.None);
    Assert.Equal("Other", stillThere!.Name); // untouched by the failed rename
  }

  [Fact]
  public async Task ReSavingAnActionWithItsOwnUnchangedNameDoesNotSelfConflict()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new ActionStore(documentStore, TimeProvider.System);
    var created = await store.CreateAsync(BuildUpsert("Hype"), CancellationToken.None);

    var updated = await store.UpdateAsync(created.Value.Id, BuildUpsert("Hype", new TtsSpeakActionStep { Template = "hi" }), CancellationToken.None);

    Assert.NotNull(updated);
    Assert.True(updated.IsSuccess);
  }

  // ---------------------------------------------------------------------------------------
  // Delete
  // ---------------------------------------------------------------------------------------

  [Fact]
  public async Task DeleteOnAnUnknownIdReturnsFalse()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new ActionStore(documentStore, TimeProvider.System);

    var deleted = await store.DeleteAsync(Guid.NewGuid(), CancellationToken.None);

    Assert.False(deleted);
  }

  [Fact]
  public async Task DeleteRemovesTheActionAndItsEmbeddedSteps()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new ActionStore(documentStore, TimeProvider.System);
    var created = await store.CreateAsync(BuildUpsert(), CancellationToken.None);

    var deleted = await store.DeleteAsync(created.Value.Id, CancellationToken.None);

    Assert.True(deleted);
    var fetched = await store.GetByIdAsync(created.Value.Id, CancellationToken.None);
    Assert.Null(fetched);
  }
}
