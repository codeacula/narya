using FluentResults;

namespace Narya.Twitch.Oauth;

/// <summary>
/// Talks to Twitch's OAuth token endpoint for the three grant types Narya needs: exchanging
/// an authorization code (the OAuth callback), refreshing a stored user token
/// (<c>ITwitchCredentials</c>'s lazy refresh), and the app-only client_credentials grant
/// (also <c>ITwitchCredentials</c>, but never persisted). Implemented by
/// <see cref="TwitchOAuthClient"/>; kept as an interface so callers depend on the contract
/// rather than the HTTP details.
/// </summary>
public interface ITwitchOAuthClient
{
  Task<Result<TwitchTokenResponse>> ExchangeCodeAsync(string code, string redirectUri, CancellationToken cancellationToken);

  Task<Result<TwitchTokenResponse>> RefreshAsync(string refreshToken, CancellationToken cancellationToken);

  Task<Result<TwitchTokenResponse>> ClientCredentialsAsync(CancellationToken cancellationToken);
}
