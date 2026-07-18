using System.Net;
using System.Net.Http.Headers;

using FluentResults;

using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.Extensions.DependencyInjection;

using Narya.Api.Auth;
using Narya.Core.Actions;
using Narya.Core.AppConfig;
using Narya.Core.Automod;
using Narya.Core.Chat;
using Narya.Core.Events;
using Narya.Core.Media;
using Narya.Core.Sessions;
using Narya.Core.Viewers;
using Narya.Twitch;
using Narya.Twitch.EventSub;
using Narya.Twitch.Helix;
using Narya.Twitch.Oauth;
using Narya.Twitch.Tokens;

using NSubstitute;

using DomainConfig = Narya.Domain.AppConfig.AppConfig;

namespace Narya.Api.Tests.Twitch;

/// <summary>
/// Exercises <c>/api/auth/twitch*</c> end to end through a real host under
/// <c>Narya:SkipInfrastructure=true</c> (no live Postgres/Redis — see
/// <c>ConfigControllerTests</c>/<c>DashboardTokenMiddlewareTests</c> for the same pattern).
/// <see cref="IAppConfigStore"/>, <see cref="ITwitchOAuthClient"/>, <see cref="ITwitchTokenStore"/>,
/// and <see cref="ITwitchEventSource"/> are substituted via <c>ConfigureTestServices</c> —
/// <c>AddNaryaTwitch</c> (which would normally register the real/no-op implementations) never
/// runs under the infrastructure guard. The middleware's exempt-path allowlist needs no
/// substitution: it is exercised directly against the real <see cref="DashboardTokenMiddleware"/>.
/// <see cref="IStreamSessionStore"/>, <see cref="IChatStore"/>, <see cref="IStreamEventStore"/>,
/// and <see cref="IViewerStore"/> are substituted too (unconfigured — nothing here exercises
/// them), purely so the Sessions, chat, Events, and Viewers MediatR handlers' constructor
/// dependencies resolve under DI validation, same reason as the other four.
/// </summary>
public sealed class TwitchAuthControllerTests
{
  private const string OperatorToken = "op-token";
  private const string RedirectUri = "http://localhost:5000/api/auth/twitch/callback";
  private const string StateCookieName = "narya_twitch_oauth_state";

  private static readonly DomainConfig ConfiguredAppConfig = new()
  {
    TwitchClientId = "the-client-id",
    TwitchClientSecret = "the-client-secret",
  };

  private sealed record TestClient(
    HttpClient Client,
    IAppConfigStore AppConfigStore,
    ITwitchOAuthClient OAuthClient,
    ITwitchTokenStore TokenStore,
    ITwitchEventSource EventSource);

  private static TestClient BuildOperatorClient(DomainConfig? appConfig = null)
  {
    var appConfigStore = Substitute.For<IAppConfigStore>();
    _ = appConfigStore.GetAsync(Arg.Any<CancellationToken>())
      .Returns(Result.Ok(appConfig ?? ConfiguredAppConfig));

    var oauthClient = Substitute.For<ITwitchOAuthClient>();
    var tokenStore = Substitute.For<ITwitchTokenStore>();
    _ = tokenStore.GetAsync(Arg.Any<TwitchProvider>(), Arg.Any<CancellationToken>())
      .Returns(Result.Ok<TwitchToken?>(null));
    var eventSource = Substitute.For<ITwitchEventSource>();

    var factory = new WebApplicationFactory<Program>()
      .WithWebHostBuilder(b =>
      {
        // UseSetting (not ConfigureAppConfiguration+AddInMemoryCollection) — see the comment
        // in DashboardTokenMiddlewareTests.BuildClient for why.
        _ = b.UseSetting("Narya:DashboardToken", OperatorToken);
        _ = b.UseSetting("Narya:SkipInfrastructure", "true");
        _ = b.UseSetting("Narya:TwitchRedirectUri", RedirectUri);

        _ = b.ConfigureTestServices(services =>
        {
          _ = services.AddSingleton(appConfigStore);
          _ = services.AddSingleton(oauthClient);
          _ = services.AddSingleton(tokenStore);
          _ = services.AddSingleton(eventSource);
          _ = services.AddSingleton(Substitute.For<IStreamSessionStore>());
          _ = services.AddSingleton(Substitute.For<IChatStore>());
          _ = services.AddSingleton(Substitute.For<IStreamEventStore>());
          _ = services.AddSingleton(Substitute.For<IViewerStore>());
          _ = services.AddSingleton(Substitute.For<IAutomodStore>());
          _ = services.AddSingleton(Substitute.For<IMediaAssetStore>());
          _ = services.AddSingleton(Substitute.For<IActionStore>());
          _ = services.AddSingleton(Substitute.For<IMediaResolver>());
          _ = services.AddSingleton(Substitute.For<IHelixClient>());
        });
      });

    var client = factory.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false });
    client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", OperatorToken);
    return new TestClient(client, appConfigStore, oauthClient, tokenStore, eventSource);
  }

  private static string SetCookieHeader(HttpResponseMessage response) =>
    Assert.Single(response.Headers.GetValues("Set-Cookie"));

  // ---- Authorize ----

  [Fact]
  public async Task AuthorizeBroadcasterRedirectsToTwitchWithScopesAndStateCookie()
  {
    var test = BuildOperatorClient();

    var response = await test.Client.GetAsync("/api/auth/twitch");

    Assert.Equal(HttpStatusCode.Redirect, response.StatusCode);
    var location = response.Headers.Location!;
    Assert.Equal("id.twitch.tv", location.Host);
    Assert.Equal("/oauth2/authorize", location.AbsolutePath);

    var query = QueryHelpers.ParseQuery(location.Query);
    Assert.Equal("the-client-id", query["client_id"]);
    Assert.Equal(RedirectUri, query["redirect_uri"]);
    Assert.Equal("code", query["response_type"]);
    Assert.StartsWith("user:", query["state"].ToString(), StringComparison.Ordinal);

    var scopes = query["scope"].ToString().Split(' ');
    Assert.Contains("channel:manage:broadcast", scopes);
    Assert.Contains("user:read:chat", scopes);
    Assert.Equal(Scopes.Broadcaster.Count, scopes.Length);

    var cookieHeader = SetCookieHeader(response);
    Assert.Contains($"{StateCookieName}=", cookieHeader, StringComparison.Ordinal);
    Assert.Contains("HttpOnly", cookieHeader, StringComparison.OrdinalIgnoreCase);
    Assert.Contains("path=/api/auth/twitch/callback", cookieHeader, StringComparison.OrdinalIgnoreCase);
    Assert.Contains("samesite=lax", cookieHeader, StringComparison.OrdinalIgnoreCase);
  }

  [Fact]
  public async Task AuthorizeBotRedirectsToTwitchWithBotScopesAndState()
  {
    var test = BuildOperatorClient();

    var response = await test.Client.GetAsync("/api/auth/twitch/bot");

    Assert.Equal(HttpStatusCode.Redirect, response.StatusCode);
    var query = QueryHelpers.ParseQuery(response.Headers.Location!.Query);
    Assert.StartsWith("bot:", query["state"].ToString(), StringComparison.Ordinal);

    var scopes = query["scope"].ToString().Split(' ');
    Assert.Equal(Scopes.Bot.Count, scopes.Length);
    Assert.Contains("user:read:chat", scopes);
    Assert.Contains("user:write:chat", scopes);
    Assert.DoesNotContain("channel:manage:broadcast", scopes);

    _ = SetCookieHeader(response);
  }

  [Fact]
  public async Task AuthorizeWithForceQuerySetsForceVerify()
  {
    var test = BuildOperatorClient();

    var response = await test.Client.GetAsync("/api/auth/twitch?force=1");

    var query = QueryHelpers.ParseQuery(response.Headers.Location!.Query);
    Assert.Equal("true", query["force_verify"]);
  }

  [Fact]
  public async Task AuthorizeWithoutForceQueryOmitsForceVerify()
  {
    var test = BuildOperatorClient();

    var response = await test.Client.GetAsync("/api/auth/twitch");

    var query = QueryHelpers.ParseQuery(response.Headers.Location!.Query);
    Assert.False(query.ContainsKey("force_verify"));
  }

  [Fact]
  public async Task AuthorizeWithOverlayTokenIsForbidden()
  {
    var test = BuildOperatorClient();
    var overlay = OverlayToken.Derive(OperatorToken);
    test.Client.DefaultRequestHeaders.Authorization = null;

    var response = await test.Client.GetAsync($"/api/auth/twitch?token={overlay}");

    Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
  }

  // ---- Callback ----

  [Fact]
  public async Task CallbackWithErrorQueryReturns400()
  {
    var test = BuildOperatorClient();
    test.Client.DefaultRequestHeaders.Authorization = null; // exempt path — no dashboard token needed

    var response = await test.Client.GetAsync("/api/auth/twitch/callback?error=access_denied");

    Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    _ = await test.OAuthClient.DidNotReceive().ExchangeCodeAsync(
      Arg.Any<string>(), Arg.Any<string>(), Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task CallbackIsReachableWithoutDashboardTokenProvingExemption()
  {
    var test = BuildOperatorClient();
    test.Client.DefaultRequestHeaders.Authorization = null;

    // Missing code (and no state cookie) → 400, not 401/403 — proves the exempt path skipped
    // the dashboard-token check entirely rather than falling through to an auth failure.
    var response = await test.Client.GetAsync("/api/auth/twitch/callback");

    Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
  }

  [Fact]
  public async Task CallbackWithMismatchedStateCookieReturns400()
  {
    var test = BuildOperatorClient();
    test.Client.DefaultRequestHeaders.Authorization = null;
    test.Client.DefaultRequestHeaders.Add("Cookie", $"{StateCookieName}=cookie-guid-111");

    var response = await test.Client.GetAsync("/api/auth/twitch/callback?code=abc&state=user:different-guid-222");

    Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    _ = await test.OAuthClient.DidNotReceive().ExchangeCodeAsync(
      Arg.Any<string>(), Arg.Any<string>(), Arg.Any<CancellationToken>());
    _ = await test.TokenStore.DidNotReceive().SaveAsync(
      Arg.Any<TwitchProvider>(), Arg.Any<TwitchToken>(), Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task CallbackWithUnknownAccountInStateReturns400()
  {
    var test = BuildOperatorClient();
    test.Client.DefaultRequestHeaders.Authorization = null;
    test.Client.DefaultRequestHeaders.Add("Cookie", $"{StateCookieName}=guid-1");

    var response = await test.Client.GetAsync("/api/auth/twitch/callback?code=abc&state=nonsense:guid-1");

    Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
  }

  [Fact]
  public async Task CallbackWithValidBroadcasterStateExchangesPersistsReconnectsAndRedirects()
  {
    var test = BuildOperatorClient();
    test.Client.DefaultRequestHeaders.Authorization = null;
    test.Client.DefaultRequestHeaders.Add("Cookie", $"{StateCookieName}=guid-abc");

    _ = test.OAuthClient.ExchangeCodeAsync("auth-code-1", RedirectUri, Arg.Any<CancellationToken>())
      .Returns(Result.Ok(new TwitchTokenResponse
      {
        AccessToken = "access-1",
        RefreshToken = "refresh-1",
        ExpiresIn = 3600,
        Scope = Scopes.Broadcaster,
        TokenType = "bearer",
      }));
    _ = test.TokenStore.SaveAsync(Arg.Any<TwitchProvider>(), Arg.Any<TwitchToken>(), Arg.Any<CancellationToken>())
      .Returns(Result.Ok());

    var response = await test.Client.GetAsync("/api/auth/twitch/callback?code=auth-code-1&state=user:guid-abc");

    Assert.Equal(HttpStatusCode.Redirect, response.StatusCode);
    Assert.Equal("/", response.Headers.Location!.OriginalString);

    _ = await test.TokenStore.Received(1).SaveAsync(
      TwitchProvider.Broadcaster,
      Arg.Is<TwitchToken>(t => t.AccessToken == "access-1" && t.RefreshToken == "refresh-1"),
      Arg.Any<CancellationToken>());
    await test.EventSource.Received(1).ReconnectAsync();
    await test.EventSource.DidNotReceive().StopAsync();

    // The cookie must be cleared regardless of outcome.
    var cookieHeader = SetCookieHeader(response);
    Assert.Contains($"{StateCookieName}=", cookieHeader, StringComparison.Ordinal);
    Assert.Contains("expires=", cookieHeader, StringComparison.OrdinalIgnoreCase);
  }

  [Fact]
  public async Task CallbackWithValidBotStateDoesNotTriggerEventSubReconnect()
  {
    var test = BuildOperatorClient();
    test.Client.DefaultRequestHeaders.Authorization = null;
    test.Client.DefaultRequestHeaders.Add("Cookie", $"{StateCookieName}=guid-bot");

    _ = test.OAuthClient.ExchangeCodeAsync("auth-code-2", RedirectUri, Arg.Any<CancellationToken>())
      .Returns(Result.Ok(new TwitchTokenResponse
      {
        AccessToken = "bot-access-1",
        ExpiresIn = 3600,
        Scope = Scopes.Bot,
        TokenType = "bearer",
      }));
    _ = test.TokenStore.SaveAsync(Arg.Any<TwitchProvider>(), Arg.Any<TwitchToken>(), Arg.Any<CancellationToken>())
      .Returns(Result.Ok());

    var response = await test.Client.GetAsync("/api/auth/twitch/callback?code=auth-code-2&state=bot:guid-bot");

    Assert.Equal(HttpStatusCode.Redirect, response.StatusCode);
    _ = await test.TokenStore.Received(1).SaveAsync(
      TwitchProvider.Bot, Arg.Any<TwitchToken>(), Arg.Any<CancellationToken>());
    await test.EventSource.DidNotReceive().ReconnectAsync();
  }

  [Fact]
  public async Task CallbackReturns500WhenExchangeFails()
  {
    var test = BuildOperatorClient();
    test.Client.DefaultRequestHeaders.Authorization = null;
    test.Client.DefaultRequestHeaders.Add("Cookie", $"{StateCookieName}=guid-fail");

    _ = test.OAuthClient.ExchangeCodeAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<CancellationToken>())
      .Returns(Result.Fail<TwitchTokenResponse>("Twitch client id/secret is not configured."));

    var response = await test.Client.GetAsync("/api/auth/twitch/callback?code=bad&state=user:guid-fail");

    Assert.Equal(HttpStatusCode.InternalServerError, response.StatusCode);
    _ = await test.TokenStore.DidNotReceive().SaveAsync(
      Arg.Any<TwitchProvider>(), Arg.Any<TwitchToken>(), Arg.Any<CancellationToken>());
  }

  // ---- Status ----

  [Fact]
  public async Task StatusReflectsStoredBroadcasterTokenExpiryAndMissingScopesAndNeverLeaksAccessToken()
  {
    var test = BuildOperatorClient();
    var expiresAt = new DateTimeOffset(2026, 8, 1, 0, 0, 0, TimeSpan.Zero);
    var scopesMissingOne = Scopes.Broadcaster.Where(s => s != "bits:read").ToList();
    _ = test.TokenStore.GetAsync(TwitchProvider.Broadcaster, Arg.Any<CancellationToken>())
      .Returns(Result.Ok<TwitchToken?>(new TwitchToken
      {
        AccessToken = "super-secret-access-token",
        RefreshToken = "super-secret-refresh-token",
        Scopes = scopesMissingOne,
        TokenType = "bearer",
        ExpiresAt = expiresAt,
      }));

    var response = await test.Client.GetAsync("/api/auth/twitch/status");

    Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    var body = await response.Content.ReadAsStringAsync();
    Assert.Contains("\"twitchAuthenticated\":true", body, StringComparison.Ordinal);
    Assert.Contains("\"twitchAuthSource\":\"oauth\"", body, StringComparison.Ordinal);
    Assert.Contains("bits:read", body, StringComparison.Ordinal);
    Assert.Contains("\"twitchBotAuthenticated\":false", body, StringComparison.Ordinal);
    Assert.Contains("\"twitchBotMissingScopes\":[]", body, StringComparison.Ordinal);

    Assert.DoesNotContain("super-secret-access-token", body, StringComparison.Ordinal);
    Assert.DoesNotContain("super-secret-refresh-token", body, StringComparison.Ordinal);
  }

  [Fact]
  public async Task StatusWithNoStoredTokensReportsUnauthenticatedWithNoMissingScopes()
  {
    var test = BuildOperatorClient();

    var response = await test.Client.GetAsync("/api/auth/twitch/status");

    Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    var body = await response.Content.ReadAsStringAsync();
    Assert.Contains("\"twitchAuthenticated\":false", body, StringComparison.Ordinal);
    Assert.Contains("\"twitchAuthSource\":null", body, StringComparison.Ordinal);
    Assert.Contains("\"twitchMissingScopes\":[]", body, StringComparison.Ordinal);
  }

  [Fact]
  public async Task StatusWithOverlayTokenIsForbidden()
  {
    var test = BuildOperatorClient();
    var overlay = OverlayToken.Derive(OperatorToken);
    test.Client.DefaultRequestHeaders.Authorization = null;

    var response = await test.Client.GetAsync($"/api/auth/twitch/status?token={overlay}");

    Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    _ = await test.TokenStore.DidNotReceive().GetAsync(Arg.Any<TwitchProvider>(), Arg.Any<CancellationToken>());
  }

  [Fact]
  public async Task StatusWithNoDashboardTokenIsUnauthorized()
  {
    var test = BuildOperatorClient();
    test.Client.DefaultRequestHeaders.Authorization = null;

    var response = await test.Client.GetAsync("/api/auth/twitch/status");

    Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
  }

  // ---- Sign-out ----

  [Fact]
  public async Task SignOutBroadcasterDeletesTokenStopsEventSubAndReturnsOkStatus()
  {
    var test = BuildOperatorClient();
    _ = test.TokenStore.DeleteAsync(TwitchProvider.Broadcaster, Arg.Any<CancellationToken>())
      .Returns(Result.Ok());

    var response = await test.Client.DeleteAsync("/api/auth/twitch");

    Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    var body = await response.Content.ReadAsStringAsync();
    Assert.Contains("\"ok\":true", body, StringComparison.Ordinal);
    Assert.Contains("\"twitchAuthenticated\":false", body, StringComparison.Ordinal);

    _ = await test.TokenStore.Received(1).DeleteAsync(TwitchProvider.Broadcaster, Arg.Any<CancellationToken>());
    await test.EventSource.Received(1).StopAsync();
  }

  [Fact]
  public async Task SignOutBotDeletesBotTokenAndDoesNotStopEventSub()
  {
    var test = BuildOperatorClient();
    _ = test.TokenStore.DeleteAsync(TwitchProvider.Bot, Arg.Any<CancellationToken>())
      .Returns(Result.Ok());

    var response = await test.Client.DeleteAsync("/api/auth/twitch/bot");

    Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    _ = await test.TokenStore.Received(1).DeleteAsync(TwitchProvider.Bot, Arg.Any<CancellationToken>());
    await test.EventSource.DidNotReceive().StopAsync();
  }

  [Fact]
  public async Task SignOutWithOverlayTokenIsForbidden()
  {
    var test = BuildOperatorClient();
    var overlay = OverlayToken.Derive(OperatorToken);
    test.Client.DefaultRequestHeaders.Authorization = null;

    var response = await test.Client.DeleteAsync($"/api/auth/twitch?token={overlay}");

    Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    _ = await test.TokenStore.DidNotReceive().DeleteAsync(Arg.Any<TwitchProvider>(), Arg.Any<CancellationToken>());
  }
}
