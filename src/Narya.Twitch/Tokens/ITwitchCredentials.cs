using FluentResults;

namespace Narya.Twitch.Tokens;

/// <summary>
/// Resolves a usable Twitch access token with lazy, on-demand refresh — there is no
/// background timer; a token is refreshed the moment a caller asks for one that is expired
/// or about to expire. Implemented by <see cref="TwitchCredentials"/> (registered as a
/// singleton — it caches the app token and the broadcaster id in memory across calls).
/// </summary>
public interface ITwitchCredentials
{
  /// <summary>
  /// Returns the stored access token for <paramref name="provider"/>, refreshing and
  /// persisting it first if it is missing an expiry or expires within
  /// <see cref="TwitchCredentials.TokenExpiryRefreshBuffer"/>. Fails if no token is stored
  /// for this provider, or if the refresh itself fails (the stored token is left untouched
  /// either way — no delete, no retry).
  /// </summary>
  Task<Result<string>> GetAccessTokenAsync(TwitchProvider provider, CancellationToken cancellationToken);

  /// <summary>
  /// Returns the app (client_credentials) access token, cached in memory only — it is never
  /// written to <see cref="ITwitchTokenStore"/>. Re-requested once the cached token is
  /// missing or expires within <see cref="TwitchCredentials.TokenExpiryRefreshBuffer"/>.
  /// </summary>
  Task<Result<string>> GetAppAccessTokenAsync(CancellationToken cancellationToken);

  /// <summary>
  /// The set difference <paramref name="required"/> minus <paramref name="tokenScopes"/> —
  /// a pure computation, no I/O, so callers can check scope coverage against any token
  /// without going through the store.
  /// </summary>
  IReadOnlyList<string> MissingScopes(IReadOnlyList<string> tokenScopes, IReadOnlyList<string> required);

  /// <summary>
  /// Resolves everything an Action's Helix step needs in one call: fails (401-suitable) if
  /// no broadcaster token is connected, fails (403-suitable, naming the missing scopes) if
  /// the stored token lacks any of <paramref name="requiredScopes"/>, otherwise returns a
  /// fresh access token, the configured Client-Id, and the (cached) broadcaster id.
  /// </summary>
  Task<Result<TwitchActionCredentials>> GetActionCredentialsAsync(
    IReadOnlyList<string> requiredScopes, CancellationToken cancellationToken);
}
