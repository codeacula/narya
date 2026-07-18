using System.Globalization;

using Marten;
using Marten.Exceptions;

using Narya.Core.AppConfig;
using Narya.Database.AppConfig;
using Narya.Database.Tests.Fixtures;

using Npgsql;

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

  [Fact]
  public async Task NullAndEmptyPatchSemanticsHoldForEverySecretField()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new AppConfigStore(documentStore);

    _ = await store.UpdateAsync(
      new AppConfigPatch { TwitchClientSecret = "cs", ObsPassword = "op", DiscordBotToken = "dbt" },
      CancellationToken.None);

    // Null leaves every secret alone, even while another field changes.
    _ = await store.UpdateAsync(new AppConfigPatch { TwitchChannel = "codeacula" }, CancellationToken.None);
    var preserved = await store.GetAsync(CancellationToken.None);
    Assert.Equal("cs", preserved.Value.TwitchClientSecret);
    Assert.Equal("op", preserved.Value.ObsPassword);
    Assert.Equal("dbt", preserved.Value.DiscordBotToken);

    // An explicit empty string clears exactly the field it names, and only that one.
    _ = await store.UpdateAsync(new AppConfigPatch { ObsPassword = "" }, CancellationToken.None);
    var cleared = await store.GetAsync(CancellationToken.None);
    Assert.Equal("cs", cleared.Value.TwitchClientSecret);
    Assert.Equal("", cleared.Value.ObsPassword);
    Assert.Equal("dbt", cleared.Value.DiscordBotToken);
  }

  /// <summary>
  /// The regression guard for the review finding: an event stream is append-only, so a
  /// secret written as event data would still be readable after rotation. Asserts against
  /// the raw <c>mt_events</c> table rather than the read model — the read model would
  /// happily show the new value while the old one sat in the stream forever.
  /// </summary>
  [Fact]
  public async Task RotatingASecretLeavesTheOldValueNowhereInTheEventStore()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new AppConfigStore(documentStore);

    _ = await store.UpdateAsync(new AppConfigPatch { TwitchClientSecret = "old-secret-value" }, CancellationToken.None);
    _ = await store.UpdateAsync(new AppConfigPatch { TwitchClientSecret = "new-secret-value" }, CancellationToken.None);

    var result = await store.GetAsync(CancellationToken.None);
    Assert.Equal("new-secret-value", result.Value.TwitchClientSecret);

    Assert.Equal(0, await CountEventsContainingAsync("old-secret-value"));
    Assert.Equal(0, await CountEventsContainingAsync("new-secret-value"));
  }

  [Fact]
  public async Task NoSecretFieldEverReachesTheEventStore()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new AppConfigStore(documentStore);

    _ = await store.UpdateAsync(
      new AppConfigPatch
      {
        TwitchChannel = "codeacula",
        TwitchClientSecret = "secret-marker-a",
        ObsPassword = "secret-marker-b",
        DiscordBotToken = "secret-marker-c",
      },
      CancellationToken.None);

    // The non-secret half must still be event-sourced — otherwise this test would pass on
    // a store that simply stopped appending events at all.
    Assert.Equal(1, await CountEventsContainingAsync("codeacula"));
    Assert.Equal(0, await CountEventsContainingAsync("secret-marker-a"));
    Assert.Equal(0, await CountEventsContainingAsync("secret-marker-b"));
    Assert.Equal(0, await CountEventsContainingAsync("secret-marker-c"));
  }

  /// <summary>
  /// Both halves are written through one <c>IDocumentSession</c> and committed by a single
  /// <c>SaveChangesAsync</c>, so a failure on either half must roll back the other. The
  /// failure is induced with a NUL character in a secret value: Postgres cannot represent
  /// a NUL byte inside <c>jsonb</c>, so storing the secrets document fails at flush time
  /// — after the event has already been staged in the same transaction.
  /// </summary>
  [Fact]
  public async Task AFailedWriteCommitsNeitherHalf()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new AppConfigStore(documentStore);

    var thrown = await Assert.ThrowsAsync<MartenCommandException>(() => store.UpdateAsync(
      new AppConfigPatch { TwitchChannel = "codeacula", TwitchClientSecret = "bad\u0000secret" },
      CancellationToken.None));

    // Confirms the failure really is Postgres rejecting the flush (22P05, unsupported
    // Unicode escape) rather than something short-circuiting before either half was staged,
    // which would make the rollback assertions below vacuous.
    Assert.Contains("22P05", thrown.Message, StringComparison.Ordinal);

    var result = await store.GetAsync(CancellationToken.None);
    Assert.Equal("", result.Value.TwitchChannel); // the config half rolled back too
    Assert.Equal("", result.Value.TwitchClientSecret);
    Assert.Null(result.Value.UpdatedAt);

    await using var query = documentStore.QuerySession();
    Assert.Null(await query.Events.FetchStreamStateAsync(AppConfigStore.RootId));
    Assert.Null(await query.LoadAsync<DbAppConfigSecrets>(AppConfigStore.RootId));
  }

  /// <summary>
  /// Counts raw <c>mt_events</c> rows whose serialized data contains <paramref name="needle"/>.
  /// Deliberately bypasses Marten's typed API — the point is what is physically on disk in
  /// the append-only stream, not what the current event record shape can deserialize.
  /// </summary>
  private async Task<int> CountEventsContainingAsync(string needle)
  {
    await using var connection = new NpgsqlConnection(fixture.ConnectionString);
    await connection.OpenAsync();
    await using var command = new NpgsqlCommand(
      "select count(*) from mt_events where data::text like '%' || @needle || '%'",
      connection);
    _ = command.Parameters.AddWithValue(nameof(needle), needle);
    return Convert.ToInt32(await command.ExecuteScalarAsync(), CultureInfo.InvariantCulture);
  }
}
