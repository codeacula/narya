using Marten;

using Narya.Database.Sessions;
using Narya.Database.Tests.Fixtures;

namespace Narya.Database.Tests.Sessions;

[Collection("postgres")]
public sealed class StreamSessionStoreTests(PostgresFixture fixture)
{
  /// <summary>
  /// Mirrors <c>AppConfigStoreTests.BuildCleanDocumentStoreAsync</c> — every test in this class
  /// shares the one Postgres container behind the "postgres" collection, so a fresh
  /// <see cref="StreamSessionStore"/> alone is not enough isolation without wiping document
  /// data first.
  /// </summary>
  private async Task<IDocumentStore> BuildCleanDocumentStoreAsync()
  {
    var documentStore = fixture.CreateStore(NaryaMartenConfig.Configure);
    await documentStore.Storage.ApplyAllConfiguredChangesToDatabaseAsync();
    await documentStore.Advanced.Clean.DeleteAllEventDataAsync(CancellationToken.None);
    await documentStore.Advanced.Clean.DeleteAllDocumentsAsync(CancellationToken.None);
    return documentStore;
  }

  [Fact]
  public async Task GetActiveSessionReturnsNullWhenNoneExists()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new StreamSessionStore(documentStore);

    var active = await store.GetActiveSessionAsync(CancellationToken.None);

    Assert.Null(active);
  }

  [Fact]
  public async Task GetOrStartSessionIsIdempotentForTheSameSource()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new StreamSessionStore(documentStore);
    var startedAt = DateTimeOffset.UtcNow;

    var first = await store.GetOrStartSessionAsync("twitch:123", startedAt, CancellationToken.None);
    var second = await store.GetOrStartSessionAsync("twitch:123", startedAt.AddMinutes(5), CancellationToken.None);

    Assert.Equal(first.Id, second.Id);
    Assert.Equal(startedAt, second.StartedAt); // NOT restarted — the second call's startedAt is ignored
    Assert.Null(second.EndedAt);
  }

  [Fact]
  public async Task StartingANewSourceClosesThePreviouslyOpenSessionAndOnlyOneStaysActive()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new StreamSessionStore(documentStore);

    var first = await store.GetOrStartSessionAsync("twitch:1", DateTimeOffset.UtcNow, CancellationToken.None);
    var secondStartedAt = DateTimeOffset.UtcNow.AddMinutes(10);
    var second = await store.GetOrStartSessionAsync("twitch:2", secondStartedAt, CancellationToken.None);

    await using var query = documentStore.QuerySession();
    var reloadedFirst = await query.LoadAsync<StreamSessionDocument>(first.Id);
    Assert.Equal(secondStartedAt, reloadedFirst!.EndedAt);

    var openCount = await query.Query<StreamSessionDocument>().Where(s => s.EndedAt == null).CountAsync();
    Assert.Equal(1, openCount);

    var active = await store.GetActiveSessionAsync(CancellationToken.None);
    Assert.Equal(second.Id, active!.Id);
  }

  /// <summary>
  /// THE RACE. N concurrent <c>stream.online</c> deliveries for the SAME source, all released
  /// together from a <see cref="Barrier"/> so they hit the store at genuinely the same time —
  /// Twitch redelivers <c>stream.online</c> routinely. The old pre-check (re-read, then insert if
  /// nothing found) is passed by every one of them before any of them writes; only the partial
  /// unique index over <c>OpenMarker</c> can hold the line.
  /// </summary>
  [Fact]
  public async Task ConcurrentStreamOnlineDeliveriesForOneSourceLeaveExactlyOneOpenSession()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new StreamSessionStore(documentStore);
    var startedAt = DateTimeOffset.UtcNow;

    const int Racers = 8;
    using var gate = new Barrier(Racers);
    var starts = Enumerable.Range(0, Racers).Select(_ => Task.Run(async () =>
    {
      gate.SignalAndWait();
      return await store.GetOrStartSessionAsync("twitch:race", startedAt, CancellationToken.None);
    }));

    var sessions = await Task.WhenAll(starts);

    // Every caller must have been handed the SAME session — a redelivery is not an error, and a
    // caller that got a different id would go on to attribute chatters to a phantom session.
    _ = Assert.Single(sessions.Select(s => s.Id).Distinct());

    await using var query = documentStore.QuerySession();
    var open = await query.Query<StreamSessionDocument>().Where(s => s.EndedAt == null).ToListAsync();
    _ = Assert.Single(open);
    var all = await query.Query<StreamSessionDocument>().CountAsync();
    Assert.Equal(1, all); // and no orphaned closed rows from the losers' rolled-back transactions
  }

  /// <summary>
  /// The same race across DIFFERENT sources — two stream restarts landing together. Only one may
  /// end up open; the other's whole transaction (its close of the previous session included) is
  /// rolled back, so the winner is still open and reachable.
  /// </summary>
  [Fact]
  public async Task ConcurrentStreamOnlineDeliveriesForDifferentSourcesLeaveExactlyOneOpenSession()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new StreamSessionStore(documentStore);
    var startedAt = DateTimeOffset.UtcNow;

    const int Racers = 6;
    using var gate = new Barrier(Racers);
    var starts = Enumerable.Range(0, Racers).Select(i => Task.Run(async () =>
    {
      gate.SignalAndWait();
      return await store.GetOrStartSessionAsync($"twitch:{i}", startedAt, CancellationToken.None);
    }));

    _ = await Task.WhenAll(starts);

    await using var query = documentStore.QuerySession();
    var open = await query.Query<StreamSessionDocument>().Where(s => s.EndedAt == null).ToListAsync();
    _ = Assert.Single(open);

    var active = await store.GetActiveSessionAsync(CancellationToken.None);
    Assert.Equal(open[0].Id, active!.Id);
  }

  [Fact]
  public async Task EndActiveSessionClosesTheOpenSession()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new StreamSessionStore(documentStore);
    var started = await store.GetOrStartSessionAsync("twitch:1", DateTimeOffset.UtcNow, CancellationToken.None);

    var endedAt = DateTimeOffset.UtcNow.AddMinutes(30);
    await store.EndActiveSessionAsync(endedAt, CancellationToken.None);

    var active = await store.GetActiveSessionAsync(CancellationToken.None);
    Assert.Null(active);

    await using var query = documentStore.QuerySession();
    var reloaded = await query.LoadAsync<StreamSessionDocument>(started.Id);
    Assert.Equal(endedAt, reloaded!.EndedAt);
  }

  [Fact]
  public async Task RecordCurrentSessionChatterIsFirstOnlyOnce()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new StreamSessionStore(documentStore);
    var session = await store.GetOrStartSessionAsync("twitch:1", DateTimeOffset.UtcNow, CancellationToken.None);

    var first = await store.RecordCurrentSessionChatterAsync("Viewer", "msg-1", DateTimeOffset.UtcNow, CancellationToken.None);
    var second = await store.RecordCurrentSessionChatterAsync("viewer", "msg-2", DateTimeOffset.UtcNow, CancellationToken.None);

    Assert.Equal(session.Id, first.SessionId);
    Assert.True(first.IsFirstInSession);
    Assert.Equal(session.Id, second.SessionId);
    Assert.False(second.IsFirstInSession); // same login (case-insensitive), redelivered/repeat chat
  }

  [Fact]
  public async Task RecordCurrentSessionChatterWithNoActiveSessionReturnsNullSessionId()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new StreamSessionStore(documentStore);

    var result = await store.RecordCurrentSessionChatterAsync("viewer", "msg-1", DateTimeOffset.UtcNow, CancellationToken.None);

    Assert.Null(result.SessionId);
    Assert.False(result.IsFirstInSession);
  }

  [Fact]
  public async Task GetSessionChatterCountReflectsDistinctChattersForTheCurrentSessionOnly()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new StreamSessionStore(documentStore);
    _ = await store.GetOrStartSessionAsync("twitch:1", DateTimeOffset.UtcNow, CancellationToken.None);

    _ = await store.RecordCurrentSessionChatterAsync("alice", "m1", DateTimeOffset.UtcNow, CancellationToken.None);
    _ = await store.RecordCurrentSessionChatterAsync("bob", "m2", DateTimeOffset.UtcNow, CancellationToken.None);
    _ = await store.RecordCurrentSessionChatterAsync("alice", "m3", DateTimeOffset.UtcNow, CancellationToken.None); // dedup, no-op

    var count = await store.GetSessionChatterCountAsync(CancellationToken.None);

    Assert.Equal(2, count);
  }

  [Fact]
  public async Task GetSessionChatterCountIsZeroWithNoActiveSession()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new StreamSessionStore(documentStore);

    var count = await store.GetSessionChatterCountAsync(CancellationToken.None);

    Assert.Equal(0, count);
  }
}
