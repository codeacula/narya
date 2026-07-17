using FluentResults;

using Microsoft.Extensions.Logging;

using Narya.Core.AppConfig;
using Narya.Twitch.Oauth;

namespace Narya.Twitch.Tokens;

/// <summary>
/// The credential-resolution layer every Helix/EventSub caller goes through instead of
/// touching <see cref="ITwitchTokenStore"/> or <see cref="ITwitchOAuthClient"/> directly.
/// Registered as a singleton: the app access token and the broadcaster id are cached in
/// memory across the process lifetime (<see cref="_appToken"/>, <see cref="_cachedBroadcasterId"/>),
/// which only makes sense if there is exactly one instance.
/// </summary>
public sealed partial class TwitchCredentials(
  ITwitchOAuthClient oauthClient,
  ITwitchTokenStore tokenStore,
  IBroadcasterIdResolver broadcasterIdResolver,
  IAppConfigStore appConfigStore,
  TimeProvider timeProvider,
  ILogger<TwitchCredentials> logger) : ITwitchCredentials, IDisposable
{
  /// <summary>
  /// A stored token is treated as due for refresh once its remaining lifetime drops inside
  /// this window, matching the legacy 60-second buffer — otherwise a token could pass the
  /// freshness check here and then expire microseconds later, mid-Helix-call.
  /// </summary>
  public static readonly TimeSpan TokenExpiryRefreshBuffer = TimeSpan.FromSeconds(60);

  private readonly SemaphoreSlim _appTokenLock = new(1, 1);
  private (string Token, DateTimeOffset ExpiresAt)? _appToken;
  private string? _cachedBroadcasterId;

  public async Task<Result<string>> GetAccessTokenAsync(TwitchProvider provider, CancellationToken cancellationToken)
  {
    var storedResult = await tokenStore.GetAsync(provider, cancellationToken).ConfigureAwait(false);
    if (storedResult.IsFailed)
    {
      return Result.Fail<string>(storedResult.Errors);
    }

    var stored = storedResult.Value;
    if (stored is null)
    {
      return Result.Fail<string>($"No stored Twitch {provider} token — the operator must connect this account.");
    }

    var now = timeProvider.GetUtcNow();
    var isFresh = stored.ExpiresAt is { } expiresAt && expiresAt > now + TokenExpiryRefreshBuffer;
    if (isFresh)
    {
      return Result.Ok(stored.AccessToken);
    }

    if (string.IsNullOrEmpty(stored.RefreshToken))
    {
      return Result.Fail<string>($"Stored Twitch {provider} token has expired and there is no refresh token to renew it.");
    }

    var refreshResult = await oauthClient.RefreshAsync(stored.RefreshToken, cancellationToken).ConfigureAwait(false);
    if (refreshResult.IsFailed || string.IsNullOrEmpty(refreshResult.Value?.AccessToken))
    {
      var reason = refreshResult.IsFailed
        ? string.Join("; ", refreshResult.Errors.Select(e => e.Message))
        : "the refresh response did not include an access token";
      LogRefreshFailed(logger, provider, reason);

      // Legacy behavior: never delete the stored token and never retry on our own — the
      // caller simply has no usable token for this attempt.
      return Result.Fail<string>($"Failed to refresh the Twitch {provider} token: {reason}");
    }

    var refreshed = refreshResult.Value;
    var renewed = new TwitchToken
    {
      AccessToken = refreshed.AccessToken!,
      RefreshToken = refreshed.RefreshToken ?? stored.RefreshToken,
      Scopes = refreshed.Scope ?? stored.Scopes,
      TokenType = refreshed.TokenType ?? stored.TokenType,
      ExpiresAt = now + TimeSpan.FromSeconds(Math.Max(60, refreshed.ExpiresIn ?? 3600)),
    };

    var saveResult = await tokenStore.SaveAsync(provider, renewed, cancellationToken).ConfigureAwait(false);
    return saveResult.IsFailed
      ? Result.Fail<string>(saveResult.Errors)
      : Result.Ok(renewed.AccessToken);
  }

  public async Task<Result<string>> GetAppAccessTokenAsync(CancellationToken cancellationToken)
  {
    if (TryGetCachedAppToken(out var cachedToken))
    {
      return Result.Ok(cachedToken);
    }

    await _appTokenLock.WaitAsync(cancellationToken).ConfigureAwait(false);
    try
    {
      // Re-check inside the lock: a concurrent caller may have already refreshed it while
      // this call was waiting for the lock.
      if (TryGetCachedAppToken(out var lockedToken))
      {
        return Result.Ok(lockedToken);
      }

      var result = await oauthClient.ClientCredentialsAsync(cancellationToken).ConfigureAwait(false);
      if (result.IsFailed || string.IsNullOrEmpty(result.Value?.AccessToken))
      {
        var reason = result.IsFailed
          ? string.Join("; ", result.Errors.Select(e => e.Message))
          : "the client_credentials response did not include an access token";
        return Result.Fail<string>($"Failed to obtain a Twitch app access token: {reason}");
      }

      var response = result.Value;
      var expiresAt = timeProvider.GetUtcNow() + TimeSpan.FromSeconds(Math.Max(60, response.ExpiresIn ?? 3600));
      _appToken = (response.AccessToken!, expiresAt);
      return Result.Ok(_appToken.Value.Token);
    }
    finally
    {
      _ = _appTokenLock.Release();
    }
  }

  public IReadOnlyList<string> MissingScopes(IReadOnlyList<string> tokenScopes, IReadOnlyList<string> required) =>
    [.. required.Except(tokenScopes)];

  public async Task<Result<TwitchActionCredentials>> GetActionCredentialsAsync(
    IReadOnlyList<string> requiredScopes, CancellationToken cancellationToken)
  {
    var storedResult = await tokenStore.GetAsync(TwitchProvider.Broadcaster, cancellationToken).ConfigureAwait(false);
    if (storedResult.IsFailed)
    {
      return Result.Fail<TwitchActionCredentials>(storedResult.Errors);
    }

    var stored = storedResult.Value;
    if (stored is null)
    {
      return Result.Fail<TwitchActionCredentials>("Twitch login is required.");
    }

    var missing = MissingScopes(stored.Scopes, requiredScopes);
    if (missing.Count > 0)
    {
      return Result.Fail<TwitchActionCredentials>($"Reconnect Twitch to grant: {string.Join(", ", missing)}");
    }

    var configResult = await appConfigStore.GetAsync(cancellationToken).ConfigureAwait(false);
    if (configResult.IsFailed)
    {
      return Result.Fail<TwitchActionCredentials>(configResult.Errors);
    }

    if (string.IsNullOrWhiteSpace(configResult.Value.TwitchClientId))
    {
      return Result.Fail<TwitchActionCredentials>("Twitch client id is not configured.");
    }

    var accessTokenResult = await GetAccessTokenAsync(TwitchProvider.Broadcaster, cancellationToken).ConfigureAwait(false);
    if (accessTokenResult.IsFailed)
    {
      return Result.Fail<TwitchActionCredentials>(accessTokenResult.Errors);
    }

    if (_cachedBroadcasterId is null)
    {
      var broadcasterIdResult = await broadcasterIdResolver.GetBroadcasterIdAsync(cancellationToken).ConfigureAwait(false);
      if (broadcasterIdResult.IsFailed)
      {
        return Result.Fail<TwitchActionCredentials>(broadcasterIdResult.Errors);
      }

      _cachedBroadcasterId = broadcasterIdResult.Value;
    }

    return Result.Ok(new TwitchActionCredentials
    {
      ClientId = configResult.Value.TwitchClientId,
      AccessToken = accessTokenResult.Value,
      BroadcasterId = _cachedBroadcasterId,
    });
  }

  /// <summary>
  /// Releases <see cref="_appTokenLock"/>. TwitchCredentials is registered as a singleton,
  /// so this only runs once, at host shutdown.
  /// </summary>
  public void Dispose() => _appTokenLock.Dispose();

  private bool TryGetCachedAppToken(out string token)
  {
    if (_appToken is { } cached && cached.ExpiresAt > timeProvider.GetUtcNow() + TokenExpiryRefreshBuffer)
    {
      token = cached.Token;
      return true;
    }

    token = "";
    return false;
  }

  [LoggerMessage(Level = LogLevel.Warning, Message = "Failed to refresh the Twitch {Provider} token: {Reason}")]
  private static partial void LogRefreshFailed(ILogger logger, TwitchProvider provider, string reason);
}
