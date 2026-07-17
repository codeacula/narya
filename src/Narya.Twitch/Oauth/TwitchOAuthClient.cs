using System.Net.Http.Json;

using FluentResults;

using Narya.Core.AppConfig;

namespace Narya.Twitch.Oauth;

/// <summary>
/// POSTs form-encoded requests to Twitch's OAuth token endpoint. Takes a plain
/// <see cref="HttpClient"/> (rather than <see cref="IHttpClientFactory"/> directly) so tests
/// can build one on a fake <see cref="HttpMessageHandler"/> with no real network call —
/// production wires it up via a named <c>IHttpClientFactory</c> client in
/// <c>ServiceCollectionExtensions.AddNaryaTwitch</c>. Client id/secret are read fresh from
/// <see cref="IAppConfigStore"/> on every call rather than cached, so an operator editing
/// them in Settings takes effect on the very next token request.
/// </summary>
public sealed class TwitchOAuthClient(HttpClient httpClient, IAppConfigStore appConfigStore) : ITwitchOAuthClient
{
  private const string TokenEndpoint = "https://id.twitch.tv/oauth2/token";

  public Task<Result<TwitchTokenResponse>> ExchangeCodeAsync(string code, string redirectUri, CancellationToken cancellationToken) =>
    PostAsync(
      new Dictionary<string, string>
      {
        ["grant_type"] = "authorization_code",
        ["code"] = code,
        ["redirect_uri"] = redirectUri,
      },
      cancellationToken);

  public Task<Result<TwitchTokenResponse>> RefreshAsync(string refreshToken, CancellationToken cancellationToken) =>
    PostAsync(
      new Dictionary<string, string>
      {
        ["grant_type"] = "refresh_token",
        ["refresh_token"] = refreshToken,
      },
      cancellationToken);

  public Task<Result<TwitchTokenResponse>> ClientCredentialsAsync(CancellationToken cancellationToken) =>
    PostAsync(
      new Dictionary<string, string>
      {
        ["grant_type"] = "client_credentials",
      },
      cancellationToken);

  private async Task<Result<TwitchTokenResponse>> PostAsync(
    Dictionary<string, string> grantFields, CancellationToken cancellationToken)
  {
    var configResult = await appConfigStore.GetAsync(cancellationToken).ConfigureAwait(false);
    if (configResult.IsFailed)
    {
      return Result.Fail<TwitchTokenResponse>(configResult.Errors);
    }

    var config = configResult.Value;
    if (string.IsNullOrWhiteSpace(config.TwitchClientId) || string.IsNullOrWhiteSpace(config.TwitchClientSecret))
    {
      return Result.Fail<TwitchTokenResponse>("Twitch client id/secret is not configured.");
    }

    grantFields["client_id"] = config.TwitchClientId;
    grantFields["client_secret"] = config.TwitchClientSecret;

    using var request = new HttpRequestMessage(HttpMethod.Post, TokenEndpoint)
    {
      Content = new FormUrlEncodedContent(grantFields),
    };

    using var response = await httpClient.SendAsync(request, cancellationToken).ConfigureAwait(false);
    var body = await response.Content.ReadFromJsonAsync<TwitchTokenResponse>(cancellationToken).ConfigureAwait(false);

    if (body is null)
    {
      return Result.Fail<TwitchTokenResponse>(
        $"Twitch token endpoint returned an unreadable response ({(int)response.StatusCode} {response.ReasonPhrase}).");
    }

    var failed = !response.IsSuccessStatusCode
      || !string.IsNullOrEmpty(body.Error)
      || !string.IsNullOrEmpty(body.Message)
      || string.IsNullOrEmpty(body.AccessToken);

    if (failed)
    {
      var message = body.Message ?? body.Error ?? $"{(int)response.StatusCode} {response.ReasonPhrase}";
      return Result.Fail<TwitchTokenResponse>(message);
    }

    return Result.Ok(body);
  }
}
