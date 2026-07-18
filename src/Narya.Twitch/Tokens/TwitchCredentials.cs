using FluentResults;

using Microsoft.Extensions.Logging;

using Narya.Core.AppConfig;
using Narya.Twitch.Identity;
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
  ILogger<TwitchCredentials> logger) : ITwitchCredentials, ITwitchIdentityCache, IDisposable
{
  /// <summary>
  /// A stored token is treated as due for refresh once its remaining lifetime drops inside
  /// this window, matching the legacy 60-second buffer — otherwise a token could pass the
  /// freshness check here and then expire microseconds later, mid-Helix-call.
  /// </summary>
  public static readonly TimeSpan TokenExpiryRefreshBuffer = TimeSpan.FromSeconds(60);

  private readonly SemaphoreSlim _appTokenLock = new(1, 1);
  private readonly SemaphoreSlim _broadcasterTokenLock = new(1, 1);
  private readonly SemaphoreSlim _botTokenLock = new(1, 1);
  private (string Token, DateTimeOffset ExpiresAt)? _appToken;
  private string? _cachedBroadcasterId;

  /// <summary>
  /// Bumped by <see cref="InvalidateAsync"/>; snapshotted before, and re-read after, every
  /// round trip whose result would be cached, so a mint or a broadcaster-id resolution that was
  /// already in flight when the invalidation landed cannot write the OLD identity back into the
  /// just-cleared field. See <see cref="InvalidateAsync"/>.
  /// </summary>
  private int _identityGeneration;

  /// <summary>
  /// Resolves a valid access token for <paramref name="provider"/>, refreshing it first when it
  /// is inside <see cref="TokenExpiryRefreshBuffer"/> of expiring. Single-flight, mirroring
  /// <see cref="GetAppAccessTokenAsync"/>'s lock-below pattern: Twitch rotates the refresh token
  /// on every use, so two callers racing to refresh with the SAME stored refresh token would
  /// have the loser hand Twitch an already-spent token and get back <c>invalid_grant</c> — a
  /// spurious failure neither caller actually deserved. Unlike the app token, there is no
  /// in-memory cache here — <see cref="ITwitchTokenStore"/> IS the source of truth, since
  /// another concurrent caller (or, in a future multi-instance deploy, another process) could
  /// have already refreshed and saved — so the double-check after acquiring the lock RE-READS
  /// the store rather than trusting an in-memory field.
  /// </summary>
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

    if (IsFresh(stored, timeProvider.GetUtcNow()))
    {
      return Result.Ok(stored.AccessToken);
    }

    var tokenLock = GetUserTokenLock(provider);
    await tokenLock.WaitAsync(cancellationToken).ConfigureAwait(false);
    try
    {
      // Re-read the store inside the lock: a concurrent caller may have already refreshed and
      // saved a fresh token while this call was waiting on the semaphore — trust that read,
      // not the snapshot taken before the lock, so only the FIRST caller through actually
      // spends the refresh token.
      var recheckResult = await tokenStore.GetAsync(provider, cancellationToken).ConfigureAwait(false);
      if (recheckResult.IsFailed)
      {
        return Result.Fail<string>(recheckResult.Errors);
      }

      var current = recheckResult.Value;
      return current switch
      {
        null => Result.Fail<string>($"No stored Twitch {provider} token — the operator must connect this account."),
        { } token when IsFresh(token, timeProvider.GetUtcNow()) => Result.Ok(token.AccessToken),
        { } token => await RefreshAndSaveAsync(provider, token, cancellationToken).ConfigureAwait(false),
      };
    }
    finally
    {
      _ = tokenLock.Release();
    }
  }

  private async Task<Result<string>> RefreshAndSaveAsync(TwitchProvider provider, TwitchToken stored, CancellationToken cancellationToken)
  {
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
      ExpiresAt = timeProvider.GetUtcNow() + TimeSpan.FromSeconds(Math.Max(60, refreshed.ExpiresIn ?? 3600)),
    };

    var saveResult = await tokenStore.SaveAsync(provider, renewed, cancellationToken).ConfigureAwait(false);
    return saveResult.IsFailed
      ? Result.Fail<string>(saveResult.Errors)
      : Result.Ok(renewed.AccessToken);
  }

  private static bool IsFresh(TwitchToken token, DateTimeOffset now) =>
    token.ExpiresAt is { } expiresAt && expiresAt > now + TokenExpiryRefreshBuffer;

  /// <summary>
  /// One lock per provider (rather than a single lock shared by both) so a broadcaster-token
  /// refresh never blocks a concurrent bot-token refresh — they hit different Twitch accounts
  /// and different rows in <see cref="ITwitchTokenStore"/>, so there is no shared state for a
  /// single lock to protect between them.
  /// </summary>
  private SemaphoreSlim GetUserTokenLock(TwitchProvider provider) => provider switch
  {
    TwitchProvider.Broadcaster => _broadcasterTokenLock,
    TwitchProvider.Bot => _botTokenLock,
    _ => throw new ArgumentOutOfRangeException(nameof(provider), provider, "Unknown Twitch provider."),
  };

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

      var generation = Volatile.Read(ref _identityGeneration);
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

      // An InvalidateAsync during the client_credentials round trip means the client id/secret
      // this token was minted from is no longer the configured one. Caching it would pin the
      // OLD application for the token's full hour; hand it back to this caller but let the next
      // one re-mint.
      if (Volatile.Read(ref _identityGeneration) == generation)
      {
        _appToken = (response.AccessToken!, expiresAt);
      }

      return Result.Ok(response.AccessToken!);
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

    var broadcasterId = _cachedBroadcasterId;
    if (broadcasterId is null)
    {
      // Snapshot the generation before the resolution: an InvalidateAsync that lands while the
      // resolver is awaiting Helix must not have the OLD broadcaster id written back into the
      // field it just cleared — nothing else ever clears it, so that id would be permanent.
      var generation = Volatile.Read(ref _identityGeneration);

      var broadcasterIdResult = await broadcasterIdResolver.GetBroadcasterIdAsync(cancellationToken).ConfigureAwait(false);
      if (broadcasterIdResult.IsFailed)
      {
        return Result.Fail<TwitchActionCredentials>(broadcasterIdResult.Errors);
      }

      broadcasterId = broadcasterIdResult.Value;
      if (Volatile.Read(ref _identityGeneration) == generation)
      {
        _cachedBroadcasterId = broadcasterId;
      }
    }

    return Result.Ok(new TwitchActionCredentials
    {
      ClientId = configResult.Value.TwitchClientId,
      AccessToken = accessTokenResult.Value,
      BroadcasterId = broadcasterId,
    });
  }

  /// <summary>
  /// Drops the cached app access token and the cached broadcaster id. The app token is minted
  /// from the Twitch client id/secret, so a credentials change makes the cached one belong to a
  /// different application entirely — and it has an hour-long lifetime, so nothing would evict
  /// it on its own. The stored USER tokens are deliberately untouched: they live in
  /// <see cref="ITwitchTokenStore"/>, which is the source of truth and is already re-read on
  /// every call (see <see cref="GetAccessTokenAsync"/>), so an OAuth reauth is picked up
  /// without any invalidation here.
  ///
  /// Not taking <see cref="_appTokenLock"/>, for the same reason
  /// <see cref="Helix.HelixClient.InvalidateAsync"/> does not take its own lock: blocking behind
  /// an in-flight <c>client_credentials</c> round trip would only serialize an operator save
  /// behind a Twitch call. Clearing the fields is not enough on its own — a mint or a
  /// broadcaster-id resolution already in flight would write the OLD identity straight back into
  /// the cleared field, where the app token's hour-long lifetime (and, for the broadcaster id,
  /// nothing at all) would evict it. <see cref="_identityGeneration"/> is bumped here so those
  /// in-flight commits are discarded instead.
  /// </summary>
  public Task InvalidateAsync(CancellationToken cancellationToken)
  {
    // Bump FIRST, so a resolution that starts after this point re-reads the new config and any
    // resolution already running observes the change before it commits.
    _ = Interlocked.Increment(ref _identityGeneration);
    _appToken = null;
    _cachedBroadcasterId = null;
    return Task.CompletedTask;
  }

  /// <summary>
  /// Releases every <see cref="SemaphoreSlim"/> this instance owns. TwitchCredentials is
  /// registered as a singleton, so this only runs once, at host shutdown.
  /// </summary>
  public void Dispose()
  {
    _appTokenLock.Dispose();
    _broadcasterTokenLock.Dispose();
    _botTokenLock.Dispose();
  }

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
