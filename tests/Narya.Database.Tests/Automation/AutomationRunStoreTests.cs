using Marten;

using Narya.Core.Actions;
using Narya.Core.Automation;
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

    var claimed = await store.TryClaimAsync(runId, triggerId, "dedupe-key-1", "someviewer", ranAt, TriggerCooldowns.None, CancellationToken.None);

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

    var first = await store.TryClaimAsync(Guid.NewGuid(), triggerId, "trigger-redelivery-key", null, ranAt, TriggerCooldowns.None, CancellationToken.None);
    var second = await store.TryClaimAsync(Guid.NewGuid(), triggerId, "trigger-redelivery-key", null, ranAt.AddSeconds(1), TriggerCooldowns.None, CancellationToken.None);

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

    var first = await store.TryClaimAsync(Guid.NewGuid(), Guid.NewGuid(), "trigger-a:evt-1", null, ranAt, TriggerCooldowns.None, CancellationToken.None);
    var second = await store.TryClaimAsync(Guid.NewGuid(), Guid.NewGuid(), "trigger-b:evt-1", null, ranAt, TriggerCooldowns.None, CancellationToken.None);

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

    var first = await store.TryClaimAsync(Guid.NewGuid(), triggerId, null, null, ranAt, TriggerCooldowns.None, CancellationToken.None);
    var second = await store.TryClaimAsync(Guid.NewGuid(), triggerId, null, null, ranAt.AddSeconds(1), TriggerCooldowns.None, CancellationToken.None);

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
    _ = await store.TryClaimAsync(runId, Guid.NewGuid(), null, null, DateTimeOffset.UtcNow, TriggerCooldowns.None, CancellationToken.None);

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
  // TryClaimAsync — cooldown admission. The claim IS the cooldown gate; see
  // IAutomationRunStore.TryClaimAsync.
  // ---------------------------------------------------------------------------------------

  [Fact]
  public async Task AClaimInsideTheGlobalCooldownWindowIsRejected()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new AutomationRunStore(documentStore);
    var triggerId = Guid.NewGuid();
    var at = DateTimeOffset.UtcNow;
    var cooldowns = new TriggerCooldowns(GlobalCooldownMs: 60_000, UserCooldownMs: 0);

    var first = await store.TryClaimAsync(Guid.NewGuid(), triggerId, "evt-1", null, at, cooldowns, CancellationToken.None);
    // A DIFFERENT event id, so the dedupe index cannot be what rejects it — only the cooldown can.
    var second = await store.TryClaimAsync(Guid.NewGuid(), triggerId, "evt-2", null, at.AddSeconds(5), cooldowns, CancellationToken.None);

    Assert.True(first);
    Assert.False(second);
  }

  [Fact]
  public async Task AClaimAfterTheGlobalCooldownWindowIsAdmitted()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new AutomationRunStore(documentStore);
    var triggerId = Guid.NewGuid();
    var at = DateTimeOffset.UtcNow;
    var cooldowns = new TriggerCooldowns(GlobalCooldownMs: 60_000, UserCooldownMs: 0);

    var first = await store.TryClaimAsync(Guid.NewGuid(), triggerId, "evt-1", null, at, cooldowns, CancellationToken.None);
    var second = await store.TryClaimAsync(Guid.NewGuid(), triggerId, "evt-2", null, at.AddMinutes(2), cooldowns, CancellationToken.None);

    Assert.True(first);
    Assert.True(second);
  }

  [Fact]
  public async Task TheUserCooldownScopesToTheActorAndDoesNotBlockAnotherViewer()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new AutomationRunStore(documentStore);
    var triggerId = Guid.NewGuid();
    var at = DateTimeOffset.UtcNow;
    var cooldowns = new TriggerCooldowns(GlobalCooldownMs: 0, UserCooldownMs: 60_000);

    var alice = await store.TryClaimAsync(Guid.NewGuid(), triggerId, "evt-1", "alice", at, cooldowns, CancellationToken.None);
    var aliceAgain = await store.TryClaimAsync(Guid.NewGuid(), triggerId, "evt-2", "alice", at.AddSeconds(5), cooldowns, CancellationToken.None);
    var bob = await store.TryClaimAsync(Guid.NewGuid(), triggerId, "evt-3", "bob", at.AddSeconds(6), cooldowns, CancellationToken.None);

    Assert.True(alice);
    Assert.False(aliceAgain);
    Assert.True(bob);
  }

  /// <summary>A cooldown is scoped to ONE trigger — a busy trigger must never gate a different one.</summary>
  [Fact]
  public async Task ACooldownOnOneTriggerDoesNotBlockAnother()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new AutomationRunStore(documentStore);
    var at = DateTimeOffset.UtcNow;
    var cooldowns = new TriggerCooldowns(GlobalCooldownMs: 60_000, UserCooldownMs: 0);

    var first = await store.TryClaimAsync(Guid.NewGuid(), Guid.NewGuid(), "evt-1", null, at, cooldowns, CancellationToken.None);
    var other = await store.TryClaimAsync(Guid.NewGuid(), Guid.NewGuid(), "evt-2", null, at.AddSeconds(1), cooldowns, CancellationToken.None);

    Assert.True(first);
    Assert.True(other);
  }

  /// <summary>
  /// THE RACE. N genuinely concurrent claims — different event ids, so the dedupe index is not
  /// what rejects them — released from one Barrier so they hit the store at the same time. Exactly
  /// one may be admitted inside a single cooldown window; a pre-check-then-insert dispatcher fails
  /// this because every task passes the check before any of them writes.
  /// </summary>
  [Fact]
  public async Task ConcurrentDistinctEventsInsideOneCooldownWindowAdmitExactlyOne()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new AutomationRunStore(documentStore);
    var triggerId = Guid.NewGuid();
    var at = DateTimeOffset.UtcNow;
    var cooldowns = new TriggerCooldowns(GlobalCooldownMs: 60_000, UserCooldownMs: 0);

    const int Racers = 8;
    using var gate = new Barrier(Racers);
    var claims = Enumerable.Range(0, Racers).Select(i => Task.Run(async () =>
    {
      gate.SignalAndWait();
      return await store.TryClaimAsync(
        Guid.NewGuid(), triggerId, $"evt-{i}", null, at.AddMilliseconds(i), cooldowns, CancellationToken.None);
    }));

    var results = await Task.WhenAll(claims);

    Assert.Equal(1, results.Count(admitted => admitted));

    // And the log agrees: a rejected claim must not have left a run row behind either.
    await using var session = documentStore.QuerySession();
    var rows = await session.Query<AutomationRunDocument>().Where(r => r.TriggerId == triggerId).ToListAsync(CancellationToken.None);
    _ = Assert.Single(rows);
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

    _ = await store.TryClaimAsync(Guid.NewGuid(), Guid.NewGuid(), "old-1", null, old1, TriggerCooldowns.None, CancellationToken.None);
    _ = await store.TryClaimAsync(Guid.NewGuid(), Guid.NewGuid(), "old-2", null, old2, TriggerCooldowns.None, CancellationToken.None);
    _ = await store.TryClaimAsync(Guid.NewGuid(), Guid.NewGuid(), "recent-1", null, recent, TriggerCooldowns.None, CancellationToken.None);

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
