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
