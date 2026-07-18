using Marten;

using Narya.Core.Actions;
using Narya.Database.Automation;
using Narya.Database.Tests.Fixtures;

namespace Narya.Database.Tests.Automation;

/// <summary>
/// Exercises <see cref="AutomationRunStore"/> against a real Postgres (Testcontainers) so the
/// PARTIAL UNIQUE INDEX on <c>DedupeKey</c> is proven at the database level, not simulated — a
/// redelivered event must be rejected by the actual constraint, not by application-level logic that
/// could silently rot out of sync with the schema.
/// </summary>
[Collection("postgres")]
public sealed class AutomationRunStoreTests(PostgresFixture fixture)
{
  private async Task<IDocumentStore> BuildCleanDocumentStoreAsync()
  {
    var documentStore = fixture.CreateStore(NaryaMartenConfig.Configure);
    await documentStore.Storage.ApplyAllConfiguredChangesToDatabaseAsync();
    await documentStore.Advanced.Clean.DeleteAllEventDataAsync(CancellationToken.None);
    await documentStore.Advanced.Clean.DeleteAllDocumentsAsync(CancellationToken.None);
    return documentStore;
  }

  // ---------------------------------------------------------------------------------------
  // TryClaimAsync — the partial unique index IS the dedup mechanism.
  // ---------------------------------------------------------------------------------------

  [Fact]
  public async Task TryClaimInsertsAProvisionalFailedRowAndReturnsTrue()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new AutomationRunStore(documentStore);
    var runId = Guid.NewGuid();
    var triggerId = Guid.NewGuid();
    var ranAt = DateTimeOffset.UtcNow;

    var claimed = await store.TryClaimAsync(runId, triggerId, "dedupe-key-1", "someviewer", ranAt, CancellationToken.None);

    Assert.True(claimed);

    await using var session = documentStore.QuerySession();
    var doc = await session.LoadAsync<AutomationRunDocument>(runId, CancellationToken.None);
    Assert.NotNull(doc);
    Assert.Equal(ActionRunStatus.Failed, doc!.Status);
    Assert.Equal("Invocation did not complete.", doc.Detail);
    Assert.Equal(triggerId, doc.TriggerId);
    Assert.Equal("dedupe-key-1", doc.DedupeKey);
    Assert.Equal("someviewer", doc.ActorLogin);
  }

  [Fact]
  public async Task ASecondClaimWithTheSameDedupeKeyReturnsFalse()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new AutomationRunStore(documentStore);
    var triggerId = Guid.NewGuid();
    var ranAt = DateTimeOffset.UtcNow;

    var first = await store.TryClaimAsync(Guid.NewGuid(), triggerId, "trigger-redelivery-key", null, ranAt, CancellationToken.None);
    var second = await store.TryClaimAsync(Guid.NewGuid(), triggerId, "trigger-redelivery-key", null, ranAt.AddSeconds(1), CancellationToken.None);

    Assert.True(first);
    Assert.False(second);

    await using var session = documentStore.QuerySession();
    var rows = await session.Query<AutomationRunDocument>().Where(r => r.TriggerId == triggerId).ToListAsync(CancellationToken.None);
    _ = Assert.Single(rows);
  }

  /// <summary>Different triggers legitimately claiming the SAME source event id must both succeed — the dedupe key is scoped per trigger, not per event.</summary>
  [Fact]
  public async Task TwoDifferentTriggersClaimingTheSameEventIdBothSucceed()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new AutomationRunStore(documentStore);
    var ranAt = DateTimeOffset.UtcNow;

    var first = await store.TryClaimAsync(Guid.NewGuid(), Guid.NewGuid(), "trigger-a:evt-1", null, ranAt, CancellationToken.None);
    var second = await store.TryClaimAsync(Guid.NewGuid(), Guid.NewGuid(), "trigger-b:evt-1", null, ranAt, CancellationToken.None);

    Assert.True(first);
    Assert.True(second);
  }

  /// <summary>A null DedupeKey (manual/module-lifecycle runs) is exempt from the uniqueness constraint — two null-key claims both succeed.</summary>
  [Fact]
  public async Task TwoClaimsWithANullDedupeKeyBothSucceed()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new AutomationRunStore(documentStore);
    var triggerId = Guid.NewGuid();
    var ranAt = DateTimeOffset.UtcNow;

    var first = await store.TryClaimAsync(Guid.NewGuid(), triggerId, null, null, ranAt, CancellationToken.None);
    var second = await store.TryClaimAsync(Guid.NewGuid(), triggerId, null, null, ranAt.AddSeconds(1), CancellationToken.None);

    Assert.True(first);
    Assert.True(second);
  }

  // ---------------------------------------------------------------------------------------
  // FinishAsync
  // ---------------------------------------------------------------------------------------

  [Fact]
  public async Task FinishAsyncUpdatesTheProvisionalRowToTheRealOutcome()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new AutomationRunStore(documentStore);
    var runId = Guid.NewGuid();
    _ = await store.TryClaimAsync(runId, Guid.NewGuid(), null, null, DateTimeOffset.UtcNow, CancellationToken.None);

    await store.FinishAsync(runId, ActionRunStatus.Succeeded, string.Empty, CancellationToken.None);

    await using var session = documentStore.QuerySession();
    var doc = await session.LoadAsync<AutomationRunDocument>(runId, CancellationToken.None);
    Assert.Equal(ActionRunStatus.Succeeded, doc!.Status);
    Assert.Equal(string.Empty, doc.Detail);
  }

  [Fact]
  public async Task FinishAsyncOnAnUnknownRunIdIsANoOp()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new AutomationRunStore(documentStore);

    var exception = await Record.ExceptionAsync(() => store.FinishAsync(Guid.NewGuid(), ActionRunStatus.Succeeded, string.Empty, CancellationToken.None));

    Assert.Null(exception);
  }

  // ---------------------------------------------------------------------------------------
  // GetLastRunAtAsync / GetLastUserRunAtAsync — the cooldown source.
  // ---------------------------------------------------------------------------------------

  [Fact]
  public async Task GetLastRunAtReturnsNullWhenTheTriggerHasNeverRun()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new AutomationRunStore(documentStore);

    var last = await store.GetLastRunAtAsync(Guid.NewGuid(), CancellationToken.None);

    Assert.Null(last);
  }

  [Fact]
  public async Task GetLastRunAtReturnsTheMostRecentRanAtAcrossAnyStatus()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new AutomationRunStore(documentStore);
    var triggerId = Guid.NewGuid();
    var older = DateTimeOffset.UtcNow.AddMinutes(-5);
    var newer = DateTimeOffset.UtcNow;

    _ = await store.TryClaimAsync(Guid.NewGuid(), triggerId, "k1", null, older, CancellationToken.None);
    _ = await store.TryClaimAsync(Guid.NewGuid(), triggerId, "k2", null, newer, CancellationToken.None);

    var last = await store.GetLastRunAtAsync(triggerId, CancellationToken.None);

    Assert.Equal(newer, last);
  }

  [Fact]
  public async Task GetLastUserRunAtScopesToBothTriggerAndActor()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new AutomationRunStore(documentStore);
    var triggerId = Guid.NewGuid();
    var at = DateTimeOffset.UtcNow;

    _ = await store.TryClaimAsync(Guid.NewGuid(), triggerId, "k1", "alice", at, CancellationToken.None);
    _ = await store.TryClaimAsync(Guid.NewGuid(), triggerId, "k2", "bob", at.AddMinutes(1), CancellationToken.None);

    var aliceLast = await store.GetLastUserRunAtAsync(triggerId, "alice", CancellationToken.None);
    var carolLast = await store.GetLastUserRunAtAsync(triggerId, "carol", CancellationToken.None);

    Assert.Equal(at, aliceLast);
    Assert.Null(carolLast);
  }

  // ---------------------------------------------------------------------------------------
  // PruneAsync
  // ---------------------------------------------------------------------------------------

  [Fact]
  public async Task PruneDeletesOnlyRowsOlderThanTheCutoffAndReturnsTheCount()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new AutomationRunStore(documentStore);
    var now = DateTimeOffset.UtcNow;
    var old1 = now.AddDays(-10);
    var old2 = now.AddDays(-8);
    var recent = now.AddDays(-1);

    _ = await store.TryClaimAsync(Guid.NewGuid(), Guid.NewGuid(), "old-1", null, old1, CancellationToken.None);
    _ = await store.TryClaimAsync(Guid.NewGuid(), Guid.NewGuid(), "old-2", null, old2, CancellationToken.None);
    _ = await store.TryClaimAsync(Guid.NewGuid(), Guid.NewGuid(), "recent-1", null, recent, CancellationToken.None);

    var cutoff = now.AddDays(-7);
    var pruned = await store.PruneAsync(cutoff, CancellationToken.None);

    Assert.Equal(2, pruned);

    await using var session = documentStore.QuerySession();
    var remaining = await session.Query<AutomationRunDocument>().ToListAsync(CancellationToken.None);
    _ = Assert.Single(remaining);
    Assert.Equal("recent-1", remaining[0].DedupeKey);
  }

  [Fact]
  public async Task PruneWithNothingToDeleteReturnsZero()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new AutomationRunStore(documentStore);

    var pruned = await store.PruneAsync(DateTimeOffset.UtcNow.AddDays(-7), CancellationToken.None);

    Assert.Equal(0, pruned);
  }
}
