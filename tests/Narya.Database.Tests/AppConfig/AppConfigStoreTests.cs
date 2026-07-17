using Marten;

using Narya.Core.AppConfig;
using Narya.Database.AppConfig;
using Narya.Database.Tests.Fixtures;

namespace Narya.Database.Tests.AppConfig;

[Collection("postgres")]
public sealed class AppConfigStoreTests(PostgresFixture fixture)
{
  /// <summary>
  /// Every test in this class exercises the same fixed <see cref="AppConfigStore.RootId"/>
  /// singleton stream against the one Postgres container shared by the whole "postgres"
  /// collection, so a fresh <see cref="AppConfigStore"/> alone is not enough isolation —
  /// without wiping event/document data first, an earlier test's writes would leak into
  /// a later test's reads. <c>ApplyAllConfiguredChangesToDatabaseAsync</c> guarantees the
  /// schema exists before the clean calls run, regardless of which test method xunit
  /// happens to execute first.
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
  public async Task GetReturnsLegacyDefaultsWhenNoStreamExists()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new AppConfigStore(documentStore);

    var result = await store.GetAsync(CancellationToken.None);

    Assert.True(result.IsSuccess);
    Assert.Equal("", result.Value.TwitchChannel);
    Assert.Equal("", result.Value.TwitchClientId);
    Assert.Equal("", result.Value.TwitchClientSecret);
    Assert.Equal("ws://127.0.0.1:4455", result.Value.ObsUrl);
    Assert.Equal("", result.Value.ObsPassword);
    Assert.Equal("Scene - ", result.Value.ObsScenePrefix);
    Assert.Equal("", result.Value.DiscordClientId);
    Assert.Equal("", result.Value.DiscordBotToken);
    Assert.Equal("http://127.0.0.1:8008", result.Value.ChatterboxBaseUrl);
    Assert.Equal(2000, result.Value.MusicPollIntervalMs);
    Assert.Equal("strawberry", result.Value.MusicPlayerctlPlayer);
    Assert.Equal(0.2, result.Value.SoundVolume);
    Assert.Null(result.Value.UpdatedAt);
  }

  [Fact]
  public async Task UpdateAppendsEventAndProjectsNewState()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new AppConfigStore(documentStore);

    var updated = await store.UpdateAsync(
      new AppConfigPatch { TwitchChannel = "codeacula", SoundVolume = 0.8 },
      CancellationToken.None);
    Assert.True(updated.IsSuccess);

    var reloaded = await store.GetAsync(CancellationToken.None);
    Assert.Equal("codeacula", reloaded.Value.TwitchChannel);
    Assert.Equal(0.8, reloaded.Value.SoundVolume);
    Assert.Equal("", reloaded.Value.TwitchClientSecret); // untouched fields keep defaults
    Assert.Equal("ws://127.0.0.1:4455", reloaded.Value.ObsUrl); // untouched fields keep defaults
    _ = Assert.NotNull(reloaded.Value.UpdatedAt);
  }

  [Fact]
  public async Task NullPatchFieldsPreserveExistingValues()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new AppConfigStore(documentStore);

    _ = await store.UpdateAsync(new AppConfigPatch { TwitchClientSecret = "s3cret" }, CancellationToken.None);
    _ = await store.UpdateAsync(new AppConfigPatch { TwitchChannel = "codeacula" }, CancellationToken.None);

    var result = await store.GetAsync(CancellationToken.None);
    Assert.Equal("s3cret", result.Value.TwitchClientSecret);
    Assert.Equal("codeacula", result.Value.TwitchChannel);
  }

  [Fact]
  public async Task EmptyStringPatchFieldClearsExistingValue()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new AppConfigStore(documentStore);

    _ = await store.UpdateAsync(new AppConfigPatch { TwitchClientSecret = "s3cret" }, CancellationToken.None);
    _ = await store.UpdateAsync(new AppConfigPatch { TwitchClientSecret = "" }, CancellationToken.None);

    var result = await store.GetAsync(CancellationToken.None);
    Assert.Equal("", result.Value.TwitchClientSecret);
  }
}
