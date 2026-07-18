using Marten;

using Narya.Core.Automod;
using Narya.Database.Automod;
using Narya.Database.Chat;
using Narya.Database.Tests.Fixtures;

namespace Narya.Database.Tests.Automod;

[Collection("postgres")]
public sealed class AutomodStoreTests(PostgresFixture fixture)
{
  /// <summary>
  /// A settable <see cref="TimeProvider"/> so tests can simulate the sweep's 2-hour window and
  /// the queue's 15-minute recently-resolved window without a real-time wait.
  /// </summary>
  private sealed class ManualTimeProvider(DateTimeOffset now) : TimeProvider
  {
    private DateTimeOffset _now = now;

    public override DateTimeOffset GetUtcNow() => _now;

    public void Set(DateTimeOffset now) => _now = now;
  }

  private async Task<IDocumentStore> BuildCleanDocumentStoreAsync()
  {
    var documentStore = fixture.CreateStore(NaryaMartenConfig.Configure);
    await documentStore.Storage.ApplyAllConfiguredChangesToDatabaseAsync();
    await documentStore.Advanced.Clean.DeleteAllEventDataAsync(CancellationToken.None);
    await documentStore.Advanced.Clean.DeleteAllDocumentsAsync(CancellationToken.None);
    return documentStore;
  }

  private static AutomodHold BuildHold(
    string id = "held-1",
    string channel = "codeacula",
    string username = "riskyviewer",
    DateTimeOffset? heldAt = null,
    string? category = "automod",
    int? level = 2) => new(
      Id: id,
      Channel: channel,
      Username: username,
      DisplayName: "RiskyViewer",
      Message: "questionable text",
      Category: category,
      Level: level,
      HeldAt: heldAt ?? DateTimeOffset.UtcNow);

  // ---------------------------------------------------------------------------------------
  // RecordHoldAsync
  // ---------------------------------------------------------------------------------------

  [Fact]
  public async Task RecordHoldInsertsAndAppendsAChatEventAndReturnsTrue()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var chatStore = new ChatStore(documentStore);
    var store = new AutomodStore(documentStore, chatStore, TimeProvider.System);
    var hold = BuildHold();

    var inserted = await store.RecordHoldAsync(hold, CancellationToken.None);

    Assert.True(inserted);

    var stored = await store.GetHoldAsync(hold.Id, CancellationToken.None);
    Assert.NotNull(stored);
    Assert.Equal("codeacula", stored.Channel);
    Assert.Equal("riskyviewer", stored.Username);
    Assert.Equal("RiskyViewer", stored.DisplayName);
    Assert.Equal("questionable text", stored.Message);
    Assert.Equal("automod", stored.Category);
    Assert.Equal(2, stored.Level);
    Assert.Null(stored.ResolvedAt);
    Assert.Null(stored.Resolution);
    Assert.Null(stored.ResolvedBy);

    var events = await chatStore.GetRecentEventsAsync(10, CancellationToken.None);
    var appended = Assert.Single(events);
    Assert.Equal("automod.hold", appended.Type);
    Assert.Equal(hold.Id, appended.MessageId);
    Assert.Equal("riskyviewer", appended.Username);
  }

  [Fact]
  public async Task RecordHoldOnARedeliveredSameIdIsANoOp()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var chatStore = new ChatStore(documentStore);
    var store = new AutomodStore(documentStore, chatStore, TimeProvider.System);
    var original = BuildHold(category: "original-category");

    var first = await store.RecordHoldAsync(original, CancellationToken.None);
    var redelivered = await store.RecordHoldAsync(original with { Category = "tampered-category" }, CancellationToken.None);

    Assert.True(first);
    Assert.False(redelivered);

    var stored = await store.GetHoldAsync(original.Id, CancellationToken.None);
    Assert.Equal("original-category", stored!.Category); // the redelivery must not have overwritten it

    // No second chat_event append either — a redelivery is entirely a no-op, not just a
    // no-op on the projection.
    var events = await chatStore.GetRecentEventsAsync(10, CancellationToken.None);
    _ = Assert.Single(events);
  }

  // ---------------------------------------------------------------------------------------
  // ResolveHoldAsync — the three-way idempotency
  // ---------------------------------------------------------------------------------------

  [Fact]
  public async Task ResolvingAnUnresolvedHoldSetsTheFieldsAndAppendsAChatEvent()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var chatStore = new ChatStore(documentStore);
    var store = new AutomodStore(documentStore, chatStore, TimeProvider.System);
    _ = await store.RecordHoldAsync(BuildHold(), CancellationToken.None);

    var result = await store.ResolveHoldAsync("held-1", "allowed", "codeacula", authoritative: true, CancellationToken.None);

    Assert.True(result.Changed);
    Assert.NotNull(result.Hold);
    Assert.Equal("allowed", result.Hold.Resolution);
    Assert.Equal("codeacula", result.Hold.ResolvedBy);
    _ = Assert.NotNull(result.Hold.ResolvedAt);

    var events = await chatStore.GetRecentEventsAsync(10, CancellationToken.None);
    Assert.Contains(events, e => e.Type == "automod.resolve" && e.MessageId == "held-1");
  }

  [Fact]
  public async Task ResolvingAnAlreadyResolvedHoldNonAuthoritativelyIsANoOp()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var chatStore = new ChatStore(documentStore);
    var store = new AutomodStore(documentStore, chatStore, TimeProvider.System);
    _ = await store.RecordHoldAsync(BuildHold(), CancellationToken.None);
    _ = await store.ResolveHoldAsync("held-1", "denied", "codeacula", authoritative: true, CancellationToken.None);

    var result = await store.ResolveHoldAsync("held-1", "allowed", "someoneelse", authoritative: false, CancellationToken.None);

    Assert.False(result.Changed);
    Assert.Equal("denied", result.Hold!.Resolution); // unchanged
    Assert.Equal("codeacula", result.Hold.ResolvedBy); // unchanged
  }

  [Fact]
  public async Task AnAuthoritativeVerdictOverturnsASpeculativeExpiryExactlyOnce()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var chatStore = new ChatStore(documentStore);
    var store = new AutomodStore(documentStore, chatStore, TimeProvider.System);
    _ = await store.RecordHoldAsync(BuildHold(), CancellationToken.None);
    _ = await store.ResolveHoldAsync("held-1", "expired", null, authoritative: false, CancellationToken.None);

    var overturned = await store.ResolveHoldAsync("held-1", "allowed", "codeacula", authoritative: true, CancellationToken.None);

    Assert.True(overturned.Changed);
    Assert.Equal("allowed", overturned.Hold!.Resolution);
    Assert.Equal("codeacula", overturned.Hold.ResolvedBy);

    // The overturn happens exactly once — a second authoritative call against the now-"allowed"
    // hold is a no-op, even one carrying a different resolution.
    var secondAuthoritative = await store.ResolveHoldAsync("held-1", "denied", "someoneelse", authoritative: true, CancellationToken.None);
    Assert.False(secondAuthoritative.Changed);
    Assert.Equal("allowed", secondAuthoritative.Hold!.Resolution);
    Assert.Equal("codeacula", secondAuthoritative.Hold.ResolvedBy);
  }

  [Fact]
  public async Task TwoAuthoritativeResultsNeverRaceTheFirstWins()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var chatStore = new ChatStore(documentStore);
    var store = new AutomodStore(documentStore, chatStore, TimeProvider.System);
    _ = await store.RecordHoldAsync(BuildHold(), CancellationToken.None);

    var firstAuthoritative = await store.ResolveHoldAsync("held-1", "allowed", "codeacula", authoritative: true, CancellationToken.None);
    var secondAuthoritative = await store.ResolveHoldAsync("held-1", "denied", "someoneelse", authoritative: true, CancellationToken.None);

    Assert.True(firstAuthoritative.Changed);
    Assert.False(secondAuthoritative.Changed);
    Assert.Equal("allowed", secondAuthoritative.Hold!.Resolution); // first authoritative wins
    Assert.Equal("codeacula", secondAuthoritative.Hold.ResolvedBy);
  }

  [Fact]
  public async Task ResolvingAnUnknownIdReturnsNullHoldAndFalseChanged()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var chatStore = new ChatStore(documentStore);
    var store = new AutomodStore(documentStore, chatStore, TimeProvider.System);

    var result = await store.ResolveHoldAsync("does-not-exist", "allowed", "codeacula", authoritative: true, CancellationToken.None);

    Assert.False(result.Changed);
    Assert.Null(result.Hold);
  }

  // ---------------------------------------------------------------------------------------
  // SweepExpiredHoldsAsync
  // ---------------------------------------------------------------------------------------

  [Fact]
  public async Task SweepResolvesHoldsOlderThanTwoHoursAsExpiredNonAuthoritatively()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var chatStore = new ChatStore(documentStore);
    var now = DateTimeOffset.UtcNow;
    var clock = new ManualTimeProvider(now);
    var store = new AutomodStore(documentStore, chatStore, clock);
    _ = await store.RecordHoldAsync(BuildHold(id: "stale-1", heldAt: now.AddHours(-3)), CancellationToken.None);
    _ = await store.RecordHoldAsync(BuildHold(id: "fresh-1", heldAt: now.AddMinutes(-5)), CancellationToken.None);

    var swept = await store.SweepExpiredHoldsAsync(CancellationToken.None);

    // The return value is what GetAutomodQueueQueryHandler broadcasts one automod:resolved for
    // per entry — must be exactly the holds this call actually swept, not the fresh one.
    var sweptHold = Assert.Single(swept);
    Assert.Equal("stale-1", sweptHold.Id);
    Assert.Equal("expired", sweptHold.Resolution);

    var stale = await store.GetHoldAsync("stale-1", CancellationToken.None);
    Assert.Equal("expired", stale!.Resolution);
    Assert.Null(stale.ResolvedBy);

    var fresh = await store.GetHoldAsync("fresh-1", CancellationToken.None);
    Assert.Null(fresh!.Resolution);
    Assert.Null(fresh.ResolvedAt);
  }

  [Fact]
  public async Task SweptExpiryCanStillBeOverturnedAuthoritativelyAfterward()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var chatStore = new ChatStore(documentStore);
    var now = DateTimeOffset.UtcNow;
    var clock = new ManualTimeProvider(now);
    var store = new AutomodStore(documentStore, chatStore, clock);
    _ = await store.RecordHoldAsync(BuildHold(id: "stale-1", heldAt: now.AddHours(-3)), CancellationToken.None);

    _ = await store.SweepExpiredHoldsAsync(CancellationToken.None);
    var overturned = await store.ResolveHoldAsync("stale-1", "denied", "codeacula", authoritative: true, CancellationToken.None);

    Assert.True(overturned.Changed);
    Assert.Equal("denied", overturned.Hold!.Resolution);
  }

  // ---------------------------------------------------------------------------------------
  // GetQueueAsync
  // ---------------------------------------------------------------------------------------

  /// <summary>
  /// <see cref="AutomodStore.GetQueueAsync"/> no longer sweeps internally (see its doc comment on
  /// <see cref="IAutomodStore"/>) — the caller (<c>GetAutomodQueueQueryHandler</c>) is responsible
  /// for calling <see cref="AutomodStore.SweepExpiredHoldsAsync"/> first so it can broadcast the
  /// swept holds before asking for the queue. This test drives that exact two-call sequence to
  /// prove the end result still matches legacy's sweep-then-list behavior.
  /// </summary>
  [Fact]
  public async Task SweepThenGetQueueKeepsAStaleHoldOutOfPendingAndInRecentlyResolved()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var chatStore = new ChatStore(documentStore);
    var now = DateTimeOffset.UtcNow;
    var clock = new ManualTimeProvider(now);
    var store = new AutomodStore(documentStore, chatStore, clock);
    _ = await store.RecordHoldAsync(BuildHold(id: "stale-1", heldAt: now.AddHours(-3)), CancellationToken.None);
    _ = await store.RecordHoldAsync(BuildHold(id: "fresh-1", heldAt: now.AddMinutes(-5)), CancellationToken.None);

    _ = await store.SweepExpiredHoldsAsync(CancellationToken.None);
    var queue = await store.GetQueueAsync(CancellationToken.None);

    var pendingIds = queue.Pending.Select(h => h.Id).ToList();
    Assert.DoesNotContain("stale-1", pendingIds);
    Assert.Contains("fresh-1", pendingIds);
    Assert.Contains(queue.RecentlyResolved, h => h.Id == "stale-1" && h.Resolution == "expired");
  }

  /// <summary>
  /// The flip side of the test above: <see cref="AutomodStore.GetQueueAsync"/> called WITHOUT a
  /// preceding sweep still lists a stale, unresolved hold in <see cref="AutomodQueue.Pending"/> —
  /// proving the store really doesn't sweep on its own any more, rather than this being an
  /// untested assumption.
  /// </summary>
  [Fact]
  public async Task GetQueueAloneDoesNotSweepAndStillListsAStaleHoldAsPending()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var chatStore = new ChatStore(documentStore);
    var now = DateTimeOffset.UtcNow;
    var clock = new ManualTimeProvider(now);
    var store = new AutomodStore(documentStore, chatStore, clock);
    _ = await store.RecordHoldAsync(BuildHold(id: "stale-1", heldAt: now.AddHours(-3)), CancellationToken.None);

    var queue = await store.GetQueueAsync(CancellationToken.None);

    Assert.Contains(queue.Pending, h => h.Id == "stale-1");
    Assert.DoesNotContain(queue.RecentlyResolved, h => h.Id == "stale-1");
  }

  [Fact]
  public async Task PendingIsTheNewestUnresolvedHoldsResortedOldestFirst()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var chatStore = new ChatStore(documentStore);
    var now = DateTimeOffset.UtcNow;
    var store = new AutomodStore(documentStore, chatStore, new ManualTimeProvider(now));

    _ = await store.RecordHoldAsync(BuildHold(id: "held-a", heldAt: now.AddMinutes(-3)), CancellationToken.None);
    _ = await store.RecordHoldAsync(BuildHold(id: "held-b", heldAt: now.AddMinutes(-2)), CancellationToken.None);
    _ = await store.RecordHoldAsync(BuildHold(id: "held-c", heldAt: now.AddMinutes(-1)), CancellationToken.None);

    var queue = await store.GetQueueAsync(CancellationToken.None);

    // Newest selection (implicit here since all three fit under the 200 cap), re-sorted
    // oldest-first for display.
    Assert.Equal(["held-a", "held-b", "held-c"], queue.Pending.Select(h => h.Id));
  }

  /// <summary>
  /// Does not independently re-verify the literal 20-item cap or 200-item pending cap — doing so
  /// would require inserting 20+/200+ rows against a real Testcontainers Postgres purely to hit a
  /// constant, which is not a cost-effective test; the constants themselves (<c>ResolvedHistoryLimit</c>/
  /// <c>PendingLimit</c> in <see cref="AutomodStore"/>) are `Take(...)`-backed and covered by
  /// review/inspection instead.
  /// </summary>
  [Fact]
  public async Task RecentlyResolvedExcludesAResolutionOlderThanFifteenMinutes()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var chatStore = new ChatStore(documentStore);
    var now = DateTimeOffset.UtcNow;
    var clock = new ManualTimeProvider(now);
    var store = new AutomodStore(documentStore, chatStore, clock);

    _ = await store.RecordHoldAsync(BuildHold(id: "old-resolution"), CancellationToken.None);
    _ = await store.ResolveHoldAsync("old-resolution", "allowed", "codeacula", authoritative: true, CancellationToken.None);

    // Advance past the 15-minute recently-resolved window before resolving the second hold.
    clock.Set(now.AddMinutes(20));
    _ = await store.RecordHoldAsync(BuildHold(id: "recent-resolution"), CancellationToken.None);
    _ = await store.ResolveHoldAsync("recent-resolution", "denied", "codeacula", authoritative: true, CancellationToken.None);

    var queue = await store.GetQueueAsync(CancellationToken.None);

    var resolvedIds = queue.RecentlyResolved.Select(h => h.Id).ToList();
    Assert.DoesNotContain("old-resolution", resolvedIds);
    Assert.Contains("recent-resolution", resolvedIds);
  }

  [Fact]
  public async Task GetHoldReturnsNullForAnUnknownId()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var chatStore = new ChatStore(documentStore);
    var store = new AutomodStore(documentStore, chatStore, TimeProvider.System);

    var hold = await store.GetHoldAsync("does-not-exist", CancellationToken.None);

    Assert.Null(hold);
  }
}
