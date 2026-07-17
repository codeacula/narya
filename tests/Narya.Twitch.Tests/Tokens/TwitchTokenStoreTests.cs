using Marten;

using Narya.Database;
using Narya.Twitch.Tests.Fixtures;
using Narya.Twitch.Tokens;

namespace Narya.Twitch.Tests.Tokens;

[Collection("postgres")]
public sealed class TwitchTokenStoreTests(PostgresFixture fixture)
{
  /// <summary>
  /// Every test exercises the fixed per-provider streams
  /// (<see cref="TwitchTokenStore.StreamIdFor"/>) against the one Postgres container
  /// shared by the whole "postgres" collection, so a fresh <see cref="TwitchTokenStore"/>
  /// alone is not enough isolation between tests — mirrors
  /// <c>Narya.Database.Tests.AppConfig.AppConfigStoreTests</c>'s
  /// <c>BuildCleanDocumentStoreAsync</c>. Applies BOTH <see cref="NaryaMartenConfig"/> and
  /// <see cref="NaryaTwitchMartenConfig"/> — this is the direct-StoreOptions mirror of how
  /// production composes the two via <c>AddNaryaDatabase</c> + <c>AddNaryaTwitch</c>, so
  /// this test also proves DbAppConfig's events still register correctly alongside
  /// DbTwitchToken's.
  /// </summary>
  private async Task<IDocumentStore> BuildCleanDocumentStoreAsync()
  {
    var documentStore = fixture.CreateStore(options =>
    {
      NaryaMartenConfig.Configure(options);
      NaryaTwitchMartenConfig.Configure(options);
    });
    await documentStore.Storage.ApplyAllConfiguredChangesToDatabaseAsync();
    await documentStore.Advanced.Clean.DeleteAllEventDataAsync(CancellationToken.None);
    await documentStore.Advanced.Clean.DeleteAllDocumentsAsync(CancellationToken.None);
    return documentStore;
  }

  [Fact]
  public async Task GetReturnsNullWhenNoToken()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new TwitchTokenStore(documentStore);

    var result = await store.GetAsync(TwitchProvider.Broadcaster, CancellationToken.None);

    Assert.True(result.IsSuccess);
    Assert.Null(result.Value);
  }

  [Fact]
  public async Task SaveThenGetRoundTrips()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new TwitchTokenStore(documentStore);

    var token = new TwitchToken
    {
      AccessToken = "access-123",
      RefreshToken = "refresh-456",
      Scopes = Scopes.Broadcaster,
      TokenType = "bearer",
      ExpiresAt = new DateTimeOffset(2026, 8, 1, 0, 0, 0, TimeSpan.Zero),
    };

    var saved = await store.SaveAsync(TwitchProvider.Broadcaster, token, CancellationToken.None);
    Assert.True(saved.IsSuccess);

    var result = await store.GetAsync(TwitchProvider.Broadcaster, CancellationToken.None);
    Assert.True(result.IsSuccess);
    Assert.NotNull(result.Value);
    Assert.Equal(token.AccessToken, result.Value!.AccessToken);
    Assert.Equal(token.RefreshToken, result.Value.RefreshToken);
    Assert.Equal(token.Scopes, result.Value.Scopes);
    Assert.Equal(token.TokenType, result.Value.TokenType);
    Assert.Equal(token.ExpiresAt, result.Value.ExpiresAt);

    // Bot provider is an independent stream — saving Broadcaster must not touch it.
    var botResult = await store.GetAsync(TwitchProvider.Bot, CancellationToken.None);
    Assert.True(botResult.IsSuccess);
    Assert.Null(botResult.Value);
  }

  [Fact]
  public async Task DeleteRemovesToken()
  {
    await using var documentStore = await BuildCleanDocumentStoreAsync();
    var store = new TwitchTokenStore(documentStore);

    _ = await store.SaveAsync(
      TwitchProvider.Broadcaster,
      new TwitchToken { AccessToken = "temp-token", Scopes = Scopes.Broadcaster },
      CancellationToken.None);

    var deleted = await store.DeleteAsync(TwitchProvider.Broadcaster, CancellationToken.None);
    Assert.True(deleted.IsSuccess);

    var result = await store.GetAsync(TwitchProvider.Broadcaster, CancellationToken.None);
    Assert.True(result.IsSuccess);
    Assert.Null(result.Value);

    // A delete is a Cleared event appended to the existing stream, not a hard delete — the
    // stream must still exist with both events recorded (do NOT hard-delete on Delete).
    await using var query = documentStore.QuerySession();
    var streamState = await query.Events.FetchStreamStateAsync(TwitchTokenStore.StreamIdFor(TwitchProvider.Broadcaster));
    Assert.NotNull(streamState);
    Assert.Equal(2, streamState!.Version);
  }
}
