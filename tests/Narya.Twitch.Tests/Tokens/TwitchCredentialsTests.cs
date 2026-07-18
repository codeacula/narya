using FluentResults;

using Microsoft.Extensions.Logging;

using NSubstitute;

using Narya.Core.AppConfig;
using Narya.Twitch.Oauth;
using Narya.Twitch.Tokens;

using DomainConfig = Narya.Domain.AppConfig.AppConfig;

namespace Narya.Twitch.Tests.Tokens;

/// <summary>
/// Unit tests for <see cref="TwitchCredentials"/> — every collaborator
/// (<see cref="ITwitchOAuthClient"/>, <see cref="ITwitchTokenStore"/>,
/// <see cref="IBroadcasterIdResolver"/>, <see cref="IAppConfigStore"/>) is an NSubstitute
/// fake and time is driven by <see cref="ManualTimeProvider"/>, so these tests prove the
/// refresh-window and app-token-cache logic in isolation with no HTTP and no store.
/// </summary>
public sealed class TwitchCredentialsTests
{
  private static readonly DateTimeOffset Now = new(2026, 7, 17, 12, 0, 0, TimeSpan.Zero);

  private sealed class ManualTimeProvider(DateTimeOffset now) : TimeProvider
  {
    public DateTimeOffset Now { get; set; } = now;
    public override DateTimeOffset GetUtcNow() => Now;
  }

  private sealed record Fixture(
    TwitchCredentials Credentials,
    ITwitchOAuthClient OAuthClient,
    ITwitchTokenStore TokenStore,
    IBroadcasterIdResolver BroadcasterIdResolver,
    IAppConfigStore AppConfigStore,
    ManualTimeProvider TimeProvider);

  private static Fixture Build()
  {
    var oauthClient = Substitute.For<ITwitchOAuthClient>();
    var tokenStore = Substitute.For<ITwitchTokenStore>();
    var broadcasterIdResolver = Substitute.For<IBroadcasterIdResolver>();
    var appConfigStore = Substitute.For<IAppConfigStore>();
    var timeProvider = new ManualTimeProvider(Now);
    var logger = Substitute.For<ILogger<TwitchCredentials>>();

    var credentials = new TwitchCredentials(
      oauthClient, tokenStore, broadcasterIdResolver, appConfigStore, timeProvider, logger);

    return new Fixture(credentials, oauthClient, tokenStore, broadcasterIdResolver, appConfigStore, timeProvider);
  }

  [Fact]
  public async Task RefreshesExpiringSoonTokenAndPreservesOmittedFieldsOnSave()
  {
    var f = Build();
    var stored = new TwitchToken
    {
      AccessToken = "old-access",
      RefreshToken = "old-refresh",
      Scopes = Scopes.Broadcaster,
      TokenType = "bearer",
      ExpiresAt = Now + TimeSpan.FromSeconds(30), // inside the 60s buffer
    };
    _ = f.TokenStore.GetAsync(TwitchProvider.Broadcaster, Arg.Any<CancellationToken>())
      .Returns(Result.Ok<TwitchToken?>(stored));

    // Refresh response omits refresh_token and scope — both must fall back to the old values.
    _ = f.OAuthClient.RefreshAsync("old-refresh", Arg.Any<CancellationToken>())
      .Returns(Result.Ok(new TwitchTokenResponse { AccessToken = "new-access", ExpiresIn = 3600 }));
    _ = f.TokenStore.SaveAsync(TwitchProvider.Broadcaster, Arg.Any<TwitchToken>(), Arg.Any<CancellationToken>())
      .Returns(Result.Ok());

    var result = await f.Credentials.GetAccessTokenAsync(TwitchProvider.Broadcaster, CancellationToken.None);

    Assert.True(result.IsSuccess);
    Assert.Equal("new-access", result.Value);

    _ = await f.TokenStore.Received(1).SaveAsync(
      TwitchProvider.Broadcaster,
      Arg.Is<TwitchToken>(t =>
        t.AccessToken == "new-access"
        && t.RefreshToken == "old-refresh"
        && t.Scopes.SequenceEqual(Scopes.Broadcaster)
        && t.ExpiresAt == Now + TimeSpan.FromSeconds(3600)),
      Arg.Any<CancellationToken>());
  }

  /// <summary>
  /// A failed refresh must leave the stored token alone (legacy behavior: never delete on
  /// refresh failure) and must not retry on its own — the caller gets one attempt per call and
  /// simply has no usable token this time around.
  /// </summary>
  [Fact]
  public async Task DoesNotDeleteOrRetryWhenRefreshFails()
  {
    var f = Build();
    var stored = new TwitchToken
    {
      AccessToken = "old-access",
      RefreshToken = "old-refresh",
      Scopes = Scopes.Broadcaster,
      TokenType = "bearer",
      ExpiresAt = Now + TimeSpan.FromSeconds(30), // inside the 60s buffer
    };
    _ = f.TokenStore.GetAsync(TwitchProvider.Broadcaster, Arg.Any<CancellationToken>())
      .Returns(Result.Ok<TwitchToken?>(stored));
    _ = f.OAuthClient.RefreshAsync("old-refresh", Arg.Any<CancellationToken>())
      .Returns(Result.Fail<TwitchTokenResponse>("Twitch token endpoint returned a non-JSON response (HTTP 502)."));

    var result = await f.Credentials.GetAccessTokenAsync(TwitchProvider.Broadcaster, CancellationToken.None);

    Assert.True(result.IsFailed);
    _ = await f.TokenStore.DidNotReceive().DeleteAsync(Arg.Any<TwitchProvider>(), Arg.Any<CancellationToken>());
    _ = await f.OAuthClient.Received(1).RefreshAsync("old-refresh", Arg.Any<CancellationToken>());
  }

  /// <summary>
  /// Phase 2 final-review fix: two concurrent <see cref="TwitchCredentials.GetAccessTokenAsync"/>
  /// calls for the same provider, both racing in while the stored token is inside the refresh
  /// buffer, must not both call <see cref="ITwitchOAuthClient.RefreshAsync"/> — Twitch rotates
  /// the refresh token on every use, so the loser of an unguarded race would spend an
  /// already-consumed refresh token and get back <c>invalid_grant</c>. The second call must
  /// instead wait for the first to finish and reuse the token it saved.
  /// </summary>
  [Fact]
  public async Task ConcurrentGetAccessTokenCallsForTheSameProviderRefreshOnlyOnce()
  {
    var f = Build();

    // A mutable "store" so a save from the first call is visible to the second call's
    // re-read after it acquires the lock — a real ITwitchTokenStore would behave the same way.
    var currentStored = new TwitchToken
    {
      AccessToken = "old-access",
      RefreshToken = "old-refresh",
      Scopes = Scopes.Broadcaster,
      TokenType = "bearer",
      ExpiresAt = Now + TimeSpan.FromSeconds(30), // inside the 60s buffer
    };
    _ = f.TokenStore.GetAsync(TwitchProvider.Broadcaster, Arg.Any<CancellationToken>())
      .Returns(_ => Result.Ok<TwitchToken?>(currentStored));
    _ = f.TokenStore.SaveAsync(TwitchProvider.Broadcaster, Arg.Any<TwitchToken>(), Arg.Any<CancellationToken>())
      .Returns(callInfo =>
      {
        currentStored = callInfo.Arg<TwitchToken>();
        return Result.Ok();
      });

    var refreshCallCount = 0;
    var refreshStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    var releaseRefresh = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

    _ = f.OAuthClient.RefreshAsync("old-refresh", Arg.Any<CancellationToken>())
      .Returns(async _ =>
      {
        refreshCallCount++;
        refreshStarted.SetResult();
        await releaseRefresh.Task;
        return Result.Ok(new TwitchTokenResponse { AccessToken = "new-access", ExpiresIn = 3600 });
      });

    var firstCall = f.Credentials.GetAccessTokenAsync(TwitchProvider.Broadcaster, CancellationToken.None);
    await refreshStarted.Task; // the first call is now inside the lock, mid-refresh

    var secondCall = f.Credentials.GetAccessTokenAsync(TwitchProvider.Broadcaster, CancellationToken.None);
    await Task.Delay(50); // give the second call a chance to reach (and block on) the lock

    releaseRefresh.SetResult();
    var results = await Task.WhenAll(firstCall, secondCall);

    Assert.True(results[0].IsSuccess);
    Assert.True(results[1].IsSuccess);
    Assert.Equal("new-access", results[0].Value);
    Assert.Equal("new-access", results[1].Value);
    Assert.Equal(1, refreshCallCount);
    _ = await f.OAuthClient.Received(1).RefreshAsync("old-refresh", Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task DoesNotRefreshAFreshToken()
  {
    var f = Build();
    var stored = new TwitchToken
    {
      AccessToken = "still-good",
      RefreshToken = "some-refresh",
      Scopes = Scopes.Broadcaster,
      ExpiresAt = Now + TimeSpan.FromHours(1),
    };
    _ = f.TokenStore.GetAsync(TwitchProvider.Broadcaster, Arg.Any<CancellationToken>())
      .Returns(Result.Ok<TwitchToken?>(stored));

    var result = await f.Credentials.GetAccessTokenAsync(TwitchProvider.Broadcaster, CancellationToken.None);

    Assert.True(result.IsSuccess);
    Assert.Equal("still-good", result.Value);
    _ = await f.OAuthClient.DidNotReceive().RefreshAsync(Arg.Any<string>(), Arg.Any<CancellationToken>());
    _ = await f.TokenStore.DidNotReceive().SaveAsync(Arg.Any<TwitchProvider>(), Arg.Any<TwitchToken>(), Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task GetAccessTokenFailsWhenNoTokenIsStored()
  {
    var f = Build();
    _ = f.TokenStore.GetAsync(TwitchProvider.Bot, Arg.Any<CancellationToken>())
      .Returns(Result.Ok<TwitchToken?>(null));

    var result = await f.Credentials.GetAccessTokenAsync(TwitchProvider.Bot, CancellationToken.None);

    Assert.True(result.IsFailed);
    _ = await f.OAuthClient.DidNotReceive().RefreshAsync(Arg.Any<string>(), Arg.Any<CancellationToken>());
  }

  [Fact]
  public void MissingScopesComputesTheSetDifference()
  {
    var f = Build();

    var missing = f.Credentials.MissingScopes(
      tokenScopes: ["user:read:chat", "bits:read"],
      required: ["user:read:chat", "channel:manage:vips", "bits:read", "channel:read:ads"]);

    Assert.Equal(["channel:manage:vips", "channel:read:ads"], missing);
  }

  [Fact]
  public async Task GetActionCredentialsFailsWhenNoTokenIsStored()
  {
    var f = Build();
    _ = f.TokenStore.GetAsync(TwitchProvider.Broadcaster, Arg.Any<CancellationToken>())
      .Returns(Result.Ok<TwitchToken?>(null));

    var result = await f.Credentials.GetActionCredentialsAsync(["user:read:chat"], CancellationToken.None);

    Assert.True(result.IsFailed);
    Assert.Contains(result.Errors, e => e.Message.Contains("Twitch login", StringComparison.OrdinalIgnoreCase));
  }

  [Fact]
  public async Task GetActionCredentialsFailsWhenARequiredScopeIsMissing()
  {
    var f = Build();
    var stored = new TwitchToken
    {
      AccessToken = "access",
      Scopes = ["user:read:chat"],
      ExpiresAt = Now + TimeSpan.FromHours(1),
    };
    _ = f.TokenStore.GetAsync(TwitchProvider.Broadcaster, Arg.Any<CancellationToken>())
      .Returns(Result.Ok<TwitchToken?>(stored));

    var result = await f.Credentials.GetActionCredentialsAsync(
      ["user:read:chat", "channel:manage:vips"], CancellationToken.None);

    Assert.True(result.IsFailed);
    Assert.Contains(result.Errors, e => e.Message.Contains("channel:manage:vips", StringComparison.Ordinal));
    _ = await f.BroadcasterIdResolver.DidNotReceive().GetBroadcasterIdAsync(Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task GetActionCredentialsReturnsResolvedCredentialsAndCachesTheBroadcasterId()
  {
    var f = Build();
    var stored = new TwitchToken
    {
      AccessToken = "broadcaster-access",
      Scopes = Scopes.Broadcaster,
      ExpiresAt = Now + TimeSpan.FromHours(1),
    };
    _ = f.TokenStore.GetAsync(TwitchProvider.Broadcaster, Arg.Any<CancellationToken>())
      .Returns(Result.Ok<TwitchToken?>(stored));
    _ = f.AppConfigStore.GetAsync(Arg.Any<CancellationToken>())
      .Returns(Result.Ok(new DomainConfig { TwitchClientId = "the-client-id" }));
    _ = f.BroadcasterIdResolver.GetBroadcasterIdAsync(Arg.Any<CancellationToken>())
      .Returns(Result.Ok("broadcaster-42"));

    var first = await f.Credentials.GetActionCredentialsAsync(["user:read:chat"], CancellationToken.None);
    var second = await f.Credentials.GetActionCredentialsAsync(["user:read:chat"], CancellationToken.None);

    Assert.True(first.IsSuccess);
    Assert.Equal("the-client-id", first.Value.ClientId);
    Assert.Equal("broadcaster-access", first.Value.AccessToken);
    Assert.Equal("broadcaster-42", first.Value.BroadcasterId);

    Assert.True(second.IsSuccess);
    Assert.Equal("broadcaster-42", second.Value.BroadcasterId);

    // Broadcaster id is cached in memory — only resolved once across both calls.
    _ = await f.BroadcasterIdResolver.Received(1).GetBroadcasterIdAsync(Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task GetAppAccessTokenCachesWithinTheRefreshWindow()
  {
    var f = Build();
    _ = f.OAuthClient.ClientCredentialsAsync(Arg.Any<CancellationToken>())
      .Returns(Result.Ok(new TwitchTokenResponse { AccessToken = "app-token", ExpiresIn = 3600 }));

    var first = await f.Credentials.GetAppAccessTokenAsync(CancellationToken.None);
    var second = await f.Credentials.GetAppAccessTokenAsync(CancellationToken.None);

    Assert.True(first.IsSuccess);
    Assert.Equal("app-token", first.Value);
    Assert.True(second.IsSuccess);
    Assert.Equal("app-token", second.Value);

    _ = await f.OAuthClient.Received(1).ClientCredentialsAsync(Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task GetAppAccessTokenRequestsANewTokenAfterExpiry()
  {
    var f = Build();
    _ = f.OAuthClient.ClientCredentialsAsync(Arg.Any<CancellationToken>())
      .Returns(
        Result.Ok(new TwitchTokenResponse { AccessToken = "app-token-1", ExpiresIn = 3600 }),
        Result.Ok(new TwitchTokenResponse { AccessToken = "app-token-2", ExpiresIn = 3600 }));

    var first = await f.Credentials.GetAppAccessTokenAsync(CancellationToken.None);
    f.TimeProvider.Now = Now + TimeSpan.FromHours(2); // well past the first token's expiry
    var second = await f.Credentials.GetAppAccessTokenAsync(CancellationToken.None);

    Assert.Equal("app-token-1", first.Value);
    Assert.Equal("app-token-2", second.Value);
    _ = await f.OAuthClient.Received(2).ClientCredentialsAsync(Arg.Any<CancellationToken>());
  }
}
