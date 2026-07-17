using System.Net;
using System.Net.Http.Json;

using FluentResults;

using NSubstitute;

using Narya.Core.AppConfig;
using Narya.Twitch.Oauth;

using DomainConfig = Narya.Domain.AppConfig.AppConfig;

namespace Narya.Twitch.Tests.Oauth;

/// <summary>
/// Exercises <see cref="TwitchOAuthClient"/> against a <see cref="FakeHttpMessageHandler"/>
/// — no real network call ever happens. Every test asserts on the exact form-encoded body
/// sent to <c>https://id.twitch.tv/oauth2/token</c>, matching legacy's
/// <c>legacy/src/server/twitch/auth.ts</c> token-exchange behavior verbatim.
/// </summary>
public sealed class TwitchOAuthClientTests
{
  private static readonly DomainConfig ConfiguredAppConfig = new()
  {
    TwitchClientId = "the-client-id",
    TwitchClientSecret = "the-client-secret",
  };

  private static readonly string[] SampleScopes = ["user:read:chat", "user:write:chat"];

  private static (TwitchOAuthClient Client, FakeHttpMessageHandler Handler, IAppConfigStore AppConfigStore) Build(
    Func<HttpRequestMessage, string, HttpResponseMessage> respond, DomainConfig? config = null)
  {
    var handler = new FakeHttpMessageHandler(respond);
    var appConfigStore = Substitute.For<IAppConfigStore>();
    _ = appConfigStore.GetAsync(Arg.Any<CancellationToken>())
      .Returns(Result.Ok(config ?? ConfiguredAppConfig));

    var httpClient = new HttpClient(handler);
    var client = new TwitchOAuthClient(httpClient, appConfigStore);
    return (client, handler, appConfigStore);
  }

  /// <summary>
  /// <c>JsonContent.Create&lt;T&gt;(payload)</c> would infer <c>T</c> from
  /// <paramref name="payload"/>'s DECLARED type (<c>object</c>), which System.Text.Json
  /// serializes as <c>"{}"</c> — passing <c>payload.GetType()</c> explicitly makes it
  /// serialize the anonymous type's actual properties.
  /// </summary>
  private static HttpResponseMessage JsonResponse(HttpStatusCode status, object payload) => new(status)
  {
    Content = JsonContent.Create(payload, payload.GetType()),
  };

  [Fact]
  public async Task ExchangeCodeParsesSuccessResponseAndSendsExpectedFormFields()
  {
    var (client, handler, _) = Build((_, _) => JsonResponse(HttpStatusCode.OK, new
    {
      access_token = "access-abc",
      refresh_token = "refresh-def",
      expires_in = 3600,
      scope = SampleScopes,
      token_type = "bearer",
    }));

    var result = await client.ExchangeCodeAsync("auth-code-123", "https://narya.example/callback", CancellationToken.None);

    Assert.True(result.IsSuccess);
    Assert.Equal("access-abc", result.Value.AccessToken);
    Assert.Equal("refresh-def", result.Value.RefreshToken);
    Assert.Equal(3600, result.Value.ExpiresIn);
    Assert.Equal(SampleScopes, result.Value.Scope);
    Assert.Equal("bearer", result.Value.TokenType);

    var request = Assert.Single(handler.Requests);
    Assert.Equal(new Uri("https://id.twitch.tv/oauth2/token"), request.RequestUri);
    Assert.Equal("authorization_code", request.Form["grant_type"]);
    Assert.Equal("auth-code-123", request.Form["code"]);
    Assert.Equal("https://narya.example/callback", request.Form["redirect_uri"]);
    Assert.Equal("the-client-id", request.Form["client_id"]);
    Assert.Equal("the-client-secret", request.Form["client_secret"]);
  }

  [Fact]
  public async Task ExchangeCodeFailsWithMessageOnErrorBody()
  {
    var (client, _, _) = Build((_, _) => JsonResponse(HttpStatusCode.BadRequest, new
    {
      error = "invalid_request",
      message = "Invalid authorization code",
    }));

    var result = await client.ExchangeCodeAsync("bad-code", "https://narya.example/callback", CancellationToken.None);

    Assert.True(result.IsFailed);
    Assert.Contains(result.Errors, e => e.Message == "Invalid authorization code");
  }

  [Fact]
  public async Task ExchangeCodeFallsBackToErrorFieldWhenMessageMissing()
  {
    var (client, _, _) = Build((_, _) => JsonResponse(HttpStatusCode.BadRequest, new { error = "invalid_grant" }));

    var result = await client.ExchangeCodeAsync("bad-code", "https://narya.example/callback", CancellationToken.None);

    Assert.True(result.IsFailed);
    Assert.Contains(result.Errors, e => e.Message == "invalid_grant");
  }

  [Fact]
  public async Task RefreshSendsGrantTypeRefreshTokenAndRefreshToken()
  {
    var (client, handler, _) = Build((_, _) => JsonResponse(HttpStatusCode.OK, new
    {
      access_token = "new-access",
      expires_in = 3600,
    }));

    var result = await client.RefreshAsync("old-refresh-token", CancellationToken.None);

    Assert.True(result.IsSuccess);
    Assert.Equal("new-access", result.Value.AccessToken);

    var request = Assert.Single(handler.Requests);
    Assert.Equal("refresh_token", request.Form["grant_type"]);
    Assert.Equal("old-refresh-token", request.Form["refresh_token"]);
  }

  [Fact]
  public async Task ClientCredentialsSendsGrantTypeAndParsesResponse()
  {
    var (client, handler, _) = Build((_, _) => JsonResponse(HttpStatusCode.OK, new
    {
      access_token = "app-access-token",
      expires_in = 5000,
      token_type = "bearer",
    }));

    var result = await client.ClientCredentialsAsync(CancellationToken.None);

    Assert.True(result.IsSuccess);
    Assert.Equal("app-access-token", result.Value.AccessToken);

    var request = Assert.Single(handler.Requests);
    Assert.Equal("client_credentials", request.Form["grant_type"]);
    Assert.False(request.Form.ContainsKey("code"));
    Assert.False(request.Form.ContainsKey("refresh_token"));
  }

  [Fact]
  public async Task FailsWithoutSendingRequestWhenClientCredentialsNotConfigured()
  {
    var (client, handler, _) = Build(
      (_, _) => JsonResponse(HttpStatusCode.OK, new { access_token = "unused" }),
      config: new DomainConfig { TwitchClientId = "", TwitchClientSecret = "" });

    var result = await client.ExchangeCodeAsync("code", "https://narya.example/callback", CancellationToken.None);

    Assert.True(result.IsFailed);
    Assert.Empty(handler.Requests);
  }

  [Fact]
  public async Task FailsWhenSuccessResponseIsMissingAccessToken()
  {
    var (client, _, _) = Build((_, _) => JsonResponse(HttpStatusCode.OK, new { token_type = "bearer" }));

    var result = await client.RefreshAsync("some-refresh", CancellationToken.None);

    Assert.True(result.IsFailed);
  }
}
