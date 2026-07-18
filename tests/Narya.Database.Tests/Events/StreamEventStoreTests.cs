using Marten;

using Narya.Core.Events;
using Narya.Database.Events;
using Narya.Database.Tests.Fixtures;

namespace Narya.Database.Tests.Events;

[Collection("postgres")]
public sealed class StreamEventStoreTests(PostgresFixture fixture)
{
  private async Task<IDocumentStore> BuildCleanDocumentStoreAsync()
  {
    var documentStore = fixture.CreateStore(NaryaMartenConfig.Configure);
    await documentStore.Storage.ApplyAllConfiguredChangesToDatabaseAsync();
    await documentStore.Advanced.Clean.DeleteAllEventDataAsync(CancellationToken.None);
    await documentStore.Advanced.Clean.DeleteAllDocumentsAsync(CancellationToken.None);
    return documentStore;
  }

  private static StreamEvent BuildEvent(
    string id = "event-1",
    string kind = "follow",
    DateTimeOffset? receivedAt = null,
    string? sessionId = null,
    string? actorLogin = null) =>
    new(
      Id: id,
      Kind: kind,
      Actor: "Viewer",
      Detail: "followed",
      Tone: "silver",
      ReceivedAt: receivedAt ?? DateTimeOffset.UtcNow,
      ActorLogin: actorLogin,
      SessionId: sessionId);

  [Fact]
  public async Task InsertStoresTheEvent()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new StreamEventStore(documentStore);

    var inserted = await store.InsertAsync(
      BuildEvent(sessionId: "session-1", actorLogin: "viewer"), CancellationToken.None);

    Assert.True(inserted);

    var recent = await store.GetRecentAsync(10, CancellationToken.None);
    var stored = Assert.Single(recent);
    Assert.Equal("event-1", stored.Id);
    Assert.Equal("follow", stored.Kind);
    Assert.Equal("Viewer", stored.Actor);
    Assert.Equal("followed", stored.Detail);
    Assert.Equal("silver", stored.Tone);
    Assert.Equal("session-1", stored.SessionId);
    Assert.Equal("viewer", stored.ActorLogin);
  }

  [Fact]
  public async Task InsertOnASameIdReInsertIsANoOp()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new StreamEventStore(documentStore);
    var original = BuildEvent() with { Detail = "original detail" };

    var first = await store.InsertAsync(original, CancellationToken.None);
    var redelivered = await store.InsertAsync(original with { Detail = "tampered detail" }, CancellationToken.None);

    Assert.True(first);
    Assert.False(redelivered);

    var recent = await store.GetRecentAsync(10, CancellationToken.None);
    var stored = Assert.Single(recent);
    Assert.Equal("original detail", stored.Detail); // the redelivery must not have overwritten it
  }

  [Fact]
  public async Task UpdateDetailToneChangesTheStoredRowsDetailAndTone()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new StreamEventStore(documentStore);
    _ = await store.InsertAsync(BuildEvent(kind: "sub") with { Detail = "new sub · Tier 1", Tone = "warning" }, CancellationToken.None);

    await store.UpdateDetailToneAsync("event-1", "resub · Tier 1 · 3 months", "warning", CancellationToken.None);

    var recent = await store.GetRecentAsync(10, CancellationToken.None);
    var stored = Assert.Single(recent);
    Assert.Equal("resub · Tier 1 · 3 months", stored.Detail);
    Assert.Equal("warning", stored.Tone);
  }

  [Fact]
  public async Task UpdateDetailToneIsANoOpWhenTheIdIsAbsent()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new StreamEventStore(documentStore);

    // Must not throw — matches legacy's SQLite `update`, a silent no-op on zero matched rows.
    await store.UpdateDetailToneAsync("does-not-exist", "detail", "tone", CancellationToken.None);

    var recent = await store.GetRecentAsync(10, CancellationToken.None);
    Assert.Empty(recent);
  }

  [Fact]
  public async Task GetRecentReturnsMostRecentFirstCappedAtLimit()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new StreamEventStore(documentStore);
    var start = DateTimeOffset.UtcNow;

    for (var i = 0; i < 5; i++)
    {
      _ = await store.InsertAsync(BuildEvent(id: $"event-{i}", receivedAt: start.AddSeconds(i)), CancellationToken.None);
    }

    var recent = await store.GetRecentAsync(3, CancellationToken.None);

    Assert.Equal(3, recent.Count);
    Assert.Equal(["event-4", "event-3", "event-2"], recent.Select(e => e.Id)); // most-recent first, no reversal
  }

  [Fact]
  public async Task GetRecentNeverPopulatesAgo()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new StreamEventStore(documentStore);
    _ = await store.InsertAsync(BuildEvent() with { Ago = "just now" }, CancellationToken.None); // Ago on the write side is ignored

    var recent = await store.GetRecentAsync(10, CancellationToken.None);
    var stored = Assert.Single(recent);

    Assert.Null(stored.Ago);
  }
}
