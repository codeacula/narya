using Marten;

using Narya.Core.Actions;
using Narya.Core.Automation;
using Narya.Database.Actions;
using Narya.Database.Automation;
using Narya.Database.Tests.Fixtures;

namespace Narya.Database.Tests.Actions;

/// <summary>
/// THE RACE BEHIND <c>ActionReferenceLock</c>. <c>IActionStore.DeleteAsync</c>'s doc comment
/// asserts that the reference check and the delete are atomic with respect to a trigger being
/// created or repointed concurrently, and a whole mechanism exists to make that true — the
/// per-action advisory lock, <c>AutomationTriggerStore.LockedScope</c>, and the <c>ActionId</c>
/// index behind the reference query.
///
/// <para>
/// Nothing tested it. Deleting the advisory lock outright left the suite fully green, which is
/// precisely the defect class this review wave exists to close: a mechanism whose test suite
/// cannot tell whether it works. Every test here is barrier-synchronized against real Postgres
/// and FAILS if <c>ActionReferenceLock.TakeAsync</c> is removed from either side.
/// </para>
///
/// <para>
/// The invariant under test is not "the delete wins" or "the create wins" — either outcome is
/// correct, and which one happens is a genuine race. It is that the two outcomes are the ONLY
/// two: there is no interleaving in which the delete reports success AND a trigger referencing
/// the now-missing action survives. That orphan is what the lock exists to prevent, and it is
/// what every assertion below re-reads the database to rule out.
/// </para>
/// </summary>
[Collection("postgres")]
public sealed class ActionDeleteConcurrencyTests(PostgresFixture fixture)
{
  private async Task<IDocumentStore> BuildCleanDocumentStoreAsync()
  {
    var documentStore = fixture.CreateStore(NaryaMartenConfig.Configure);
    await documentStore.Storage.ApplyAllConfiguredChangesToDatabaseAsync();
    await documentStore.Advanced.Clean.DeleteAllEventDataAsync(CancellationToken.None);
    await documentStore.Advanced.Clean.DeleteAllDocumentsAsync(CancellationToken.None);
    return documentStore;
  }

  private static async Task<Guid> CreateActionAsync(IDocumentStore documentStore, string name)
  {
    var store = new ActionStore(documentStore, TimeProvider.System);
    var created = await store.CreateAsync(
      new ActionUpsert { Name = name, Steps = [new ObsTransitionActionStep()] }, CancellationToken.None);
    Assert.True(created.IsSuccess);
    return created.Value.Id;
  }

  private static AutomationTriggerUpsert TriggerUpsert(Guid actionId, string phrase) => new()
  {
    ActionId = actionId,
    Config = new ChatPhraseTriggerConfig { Phrase = phrase, Match = ChatPhraseMatch.StartsWith },
  };

  /// <summary>
  /// Re-reads every trigger and every action id straight from the database and asserts that no
  /// surviving trigger points at an action that is gone. This is the single invariant all of
  /// these tests are really about.
  /// </summary>
  private static async Task AssertNoOrphanedTriggersAsync(IDocumentStore documentStore)
  {
    await using var session = documentStore.QuerySession();
    var triggers = await session.Query<AutomationTriggerDocument>().ToListAsync(CancellationToken.None);
    var actionIds = (await session.Query<ActionDocument>().ToListAsync(CancellationToken.None))
      .Select(a => a.Id)
      .ToHashSet();

    var orphans = triggers.Where(t => !actionIds.Contains(t.ActionId)).ToList();
    Assert.True(
      orphans.Count == 0,
      $"Orphaned trigger(s) survived: {string.Join(", ", orphans.Select(o => $"{o.Id} -> missing action {o.ActionId}"))}");
  }

  /// <summary>
  /// (a) THE CREATE RACE. A DELETE of action A and a CREATE of a trigger referencing A, released
  /// from one <see cref="Barrier"/> so they contend for real.
  ///
  /// <para>
  /// Exactly one may win. If the delete commits first, the create must find the action already
  /// gone and fail with "Action not found."; if the create commits first, the delete's reference
  /// read must see it and refuse with <see cref="ActionInUseError"/> (which the controller 409s).
  /// Both succeeding is the orphan. Without the lock both transactions read a world under READ
  /// COMMITTED in which the other's write does not exist yet, and both commit.
  /// </para>
  ///
  /// <para>
  /// Repeated, because the losing interleaving is timing-dependent: a single pass can happen to
  /// serialize by luck even with the lock removed. Twenty rounds against a real connection pool
  /// is what makes the removal reliably observable rather than flaky-green.
  /// </para>
  /// </summary>
  [Fact]
  public async Task ConcurrentDeleteAndTriggerCreateNeverBothCommit()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var actionStore = new ActionStore(documentStore, TimeProvider.System);
    var triggerStore = new AutomationTriggerStore(documentStore, TimeProvider.System);

    const int Rounds = 20;
    var deleteWins = 0;
    var createWins = 0;

    for (var round = 0; round < Rounds; round++)
    {
      var actionId = await CreateActionAsync(documentStore, $"Race {round}");

      using var gate = new Barrier(2);

      var deleteTask = Task.Run(async () =>
      {
        gate.SignalAndWait();
        return await actionStore.DeleteAsync(actionId, CancellationToken.None);
      });

      var createTask = Task.Run(async () =>
      {
        gate.SignalAndWait();
        return await triggerStore.CreateAsync(TriggerUpsert(actionId, $"phrase-{round}"), CancellationToken.None);
      });

      var deleteResult = await deleteTask;
      var createResult = await createTask;

      var actionWasDeleted = deleteResult.IsSuccess && deleteResult.Value;

      // The core assertion: never both.
      Assert.False(
        actionWasDeleted && createResult.IsSuccess,
        $"Round {round}: the delete removed the action AND the trigger create succeeded — that trigger is orphaned.");

      if (actionWasDeleted)
      {
        // Delete won, so the create must have been refused for the right reason.
        Assert.True(createResult.IsFailed);
        Assert.Contains(createResult.Errors, e => e.Message == "Action not found.");
        deleteWins++;
      }
      else
      {
        // Create won, so the delete must have been refused with the typed in-use error naming
        // the trigger that blocked it — not a generic failure, and not a silent no-op.
        Assert.True(createResult.IsSuccess);
        Assert.True(deleteResult.IsFailed);
        var inUse = Assert.Single(deleteResult.Errors.OfType<ActionInUseError>());
        Assert.Contains(inUse.Triggers, t => t.Id == createResult.Value.Id);
        createWins++;
      }

      await AssertNoOrphanedTriggersAsync(documentStore);
    }

    // Sanity check on the test itself, not on the store: if one side had won all 20 rounds the
    // two branches above would never both have been exercised and this would be a much weaker
    // test than it looks. Both counters being non-zero is not guaranteed by the lock, so this is
    // asserted loosely — only that the rounds are accounted for.
    Assert.Equal(Rounds, deleteWins + createWins);
  }

  /// <summary>
  /// (b) THE REPOINT RACE — the case the review specifically called out.
  /// <c>AutomationTriggerStore.UpdateAsync</c> keys its lock on the NEW <c>ActionId</c> only, on
  /// the stated reasoning that dropping a reference can never create an orphan. This asserts that
  /// reasoning actually holds against a concurrent delete of the action being repointed TO.
  ///
  /// <para>
  /// Trigger T starts on action B; an UPDATE repoints it B→A while A is being deleted. The update
  /// locks A (its new action id) and the delete locks A, so the two DO serialize — but that is
  /// the claim, and this is what tests it. If the update instead committed against a deleted A,
  /// T would reference a missing action.
  /// </para>
  /// </summary>
  [Fact]
  public async Task ConcurrentDeleteAndTriggerRepointNeverOrphanTheRepointedTrigger()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var actionStore = new ActionStore(documentStore, TimeProvider.System);
    var triggerStore = new AutomationTriggerStore(documentStore, TimeProvider.System);

    const int Rounds = 20;

    for (var round = 0; round < Rounds; round++)
    {
      var actionA = await CreateActionAsync(documentStore, $"Repoint target {round}");
      var actionB = await CreateActionAsync(documentStore, $"Repoint source {round}");

      // T currently references B, so nothing blocks A's delete on entry.
      var trigger = await triggerStore.CreateAsync(TriggerUpsert(actionB, $"repoint-{round}"), CancellationToken.None);
      Assert.True(trigger.IsSuccess);

      using var gate = new Barrier(2);

      var deleteTask = Task.Run(async () =>
      {
        gate.SignalAndWait();
        return await actionStore.DeleteAsync(actionA, CancellationToken.None);
      });

      var repointTask = Task.Run(async () =>
      {
        gate.SignalAndWait();
        return await triggerStore.UpdateAsync(trigger.Value.Id, TriggerUpsert(actionA, $"repoint-{round}"), CancellationToken.None);
      });

      var deleteResult = await deleteTask;
      var repointResult = await repointTask;

      var actionWasDeleted = deleteResult.IsSuccess && deleteResult.Value;
      var repointSucceeded = repointResult is { IsSuccess: true };

      Assert.False(
        actionWasDeleted && repointSucceeded,
        $"Round {round}: action A was deleted AND trigger T was repointed onto it — T is orphaned.");

      if (actionWasDeleted)
      {
        // The repoint must have been refused, and T must be left untouched on B.
        Assert.NotNull(repointResult);
        Assert.True(repointResult.IsFailed);
        Assert.Contains(repointResult.Errors, e => e.Message == "Action not found.");

        var stored = await triggerStore.GetByIdAsync(trigger.Value.Id, CancellationToken.None);
        Assert.NotNull(stored);
        Assert.Equal(actionB, stored.ActionId);
      }
      else
      {
        // The repoint won: T now points at A, and A must still exist for it to point at.
        Assert.True(repointSucceeded);
        Assert.Equal(actionA, repointResult!.Value.ActionId);
        Assert.NotNull(await actionStore.GetByIdAsync(actionA, CancellationToken.None));
        Assert.True(deleteResult.IsFailed);
      }

      await AssertNoOrphanedTriggersAsync(documentStore);
    }
  }

  /// <summary>
  /// The many-writers variant: one delete against several concurrent creates all referencing the
  /// same action. Widens the contention window well past what two racers reach, and pins the
  /// stronger outcome — if the delete succeeds, EVERY create must have been refused, not merely
  /// one of them.
  /// </summary>
  [Fact]
  public async Task ADeleteRacingManyTriggerCreatesLeavesNoOrphanAndRefusesEveryLoser()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var actionStore = new ActionStore(documentStore, TimeProvider.System);
    var triggerStore = new AutomationTriggerStore(documentStore, TimeProvider.System);

    const int Rounds = 10;
    const int Creators = 6;

    for (var round = 0; round < Rounds; round++)
    {
      var actionId = await CreateActionAsync(documentStore, $"Fanout {round}");

      using var gate = new Barrier(Creators + 1);

      var deleteTask = Task.Run(async () =>
      {
        gate.SignalAndWait();
        return await actionStore.DeleteAsync(actionId, CancellationToken.None);
      });

      // ToList, NOT a lazy Select: Task.WhenAll below is only reached AFTER deleteTask is
      // awaited, so an unmaterialized enumerable would leave these six racers unstarted and the
      // seven-participant barrier permanently one signal short — the delete would block forever.
      var createTasks = Enumerable.Range(0, Creators).Select(i => Task.Run(async () =>
      {
        gate.SignalAndWait();
        return await triggerStore.CreateAsync(TriggerUpsert(actionId, $"fanout-{round}-{i}"), CancellationToken.None);
      })).ToList();

      var deleteResult = await deleteTask;
      var createResults = await Task.WhenAll(createTasks);

      if (deleteResult.IsSuccess && deleteResult.Value)
      {
        Assert.All(createResults, r =>
        {
          Assert.True(r.IsFailed);
          Assert.Contains(r.Errors, e => e.Message == "Action not found.");
        });
      }
      else
      {
        // The delete lost, so at least one create got in before its reference read, and the
        // refusal must name real committed triggers.
        //
        // NOT "names every committed trigger": the delete's refusal rolls back and releases the
        // advisory lock, at which point creators still queued on that lock proceed and commit.
        // Those commit strictly AFTER the read that produced this error, so their absence from it
        // is correct — the error is a snapshot of what blocked the delete, not a running census.
        // The invariant that must hold is the other direction, checked below: every id the error
        // names really did commit, and no trigger is left orphaned.
        var committed = createResults.Where(r => r.IsSuccess).Select(r => r.Value.Id).ToHashSet();
        Assert.NotEmpty(committed);

        var inUse = Assert.Single(deleteResult.Errors.OfType<ActionInUseError>());
        Assert.NotEmpty(inUse.Triggers);
        Assert.All(inUse.Triggers, t => Assert.Contains(t.Id, committed));
      }

      await AssertNoOrphanedTriggersAsync(documentStore);
    }
  }
}
