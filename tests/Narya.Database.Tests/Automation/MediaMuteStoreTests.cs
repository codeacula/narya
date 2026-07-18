using Marten;

using Narya.Database.Automation;
using Narya.Database.Tests.Fixtures;

namespace Narya.Database.Tests.Automation;

[Collection("postgres")]
public sealed class MediaMuteStoreTests(PostgresFixture fixture)
{
  /// <summary>
  /// Every test in this class exercises the same fixed <see cref="MediaMuteStore.RootId"/>
  /// single row against the one Postgres container shared by the whole "postgres" collection —
  /// mirrors <c>AppConfigStoreTests.BuildCleanDocumentStoreAsync</c>'s per-test isolation.
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
  public async Task GetMutedDefaultsToFalseWhenNoRowExists()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new MediaMuteStore(documentStore);

    var muted = await store.GetMutedAsync(CancellationToken.None);

    Assert.False(muted);
  }

  [Fact]
  public async Task SetMutedTrueThenGetMutedReturnsTrue()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new MediaMuteStore(documentStore);

    var setResult = await store.SetMutedAsync(true, CancellationToken.None);
    Assert.True(setResult.Muted);

    var muted = await store.GetMutedAsync(CancellationToken.None);
    Assert.True(muted);
  }

  [Fact]
  public async Task SetMutedFalseAfterTrueRoundTripsBackToFalse()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new MediaMuteStore(documentStore);

    _ = await store.SetMutedAsync(true, CancellationToken.None);
    var setResult = await store.SetMutedAsync(false, CancellationToken.None);
    Assert.False(setResult.Muted);

    var muted = await store.GetMutedAsync(CancellationToken.None);
    Assert.False(muted);
  }

  /// <summary>
  /// Legacy's <c>media_mute</c> table is a single row (<c>id integer primary key check (id = 1)</c>)
  /// updated via <c>on conflict(id) do update</c> — repeated writes must upsert the SAME row, never
  /// insert a second one. Proven here by writing three times and confirming the final read reflects
  /// only the last write (a second inserted row alongside the first would still make this pass by
  /// coincidence if GetMutedAsync only ever loads by RootId, but a genuine duplicate-row bug would
  /// surface as a Marten unique-constraint exception on the second Store call, since Id is the
  /// document's primary key).
  /// </summary>
  [Fact]
  public async Task RepeatedSetMutedCallsUpsertTheSingleRowRatherThanInsertingNewOnes()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new MediaMuteStore(documentStore);

    _ = await store.SetMutedAsync(true, CancellationToken.None);
    _ = await store.SetMutedAsync(false, CancellationToken.None);
    _ = await store.SetMutedAsync(true, CancellationToken.None);

    await using var querySession = documentStore.QuerySession();
    var allRows = await querySession.Query<MediaMuteDocument>().ToListAsync(CancellationToken.None);

    _ = Assert.Single(allRows);
    Assert.Equal(MediaMuteStore.RootId, allRows[0].Id);
    Assert.True(allRows[0].Muted);
  }
}
