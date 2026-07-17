using System.Text.Json.Serialization;

namespace Narya.Twitch.Oauth;

/// <summary>
/// The JSON shape Twitch's <c>POST https://id.twitch.tv/oauth2/token</c> endpoint returns
/// for every grant type this client uses (authorization_code, refresh_token,
/// client_credentials) — including the <c>error</c>/<c>message</c> fields Twitch sends
/// instead of a token on failure. One record covers both cases because Twitch does not
/// reliably distinguish them by HTTP status code alone, so <c>TwitchOAuthClient</c> checks
/// the body's <see cref="Error"/>/<see cref="Message"/>/<see cref="AccessToken"/> fields
/// rather than trusting the status code in isolation.
/// </summary>
public sealed record TwitchTokenResponse
{
  [JsonPropertyName("access_token")]
  public string? AccessToken { get; init; }

  [JsonPropertyName("refresh_token")]
  public string? RefreshToken { get; init; }

  [JsonPropertyName("expires_in")]
  public int? ExpiresIn { get; init; }

  [JsonPropertyName("scope")]
  public IReadOnlyList<string>? Scope { get; init; }

  [JsonPropertyName("token_type")]
  public string? TokenType { get; init; }

  [JsonPropertyName("error")]
  public string? Error { get; init; }

  [JsonPropertyName("message")]
  public string? Message { get; init; }
}
