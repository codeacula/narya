using FluentResults;

using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.Extensions.Options;

using Narya.Api.Auth;
using Narya.Core.AppConfig;
using Narya.Core.Twitch;
using Narya.Twitch;
using Narya.Twitch.EventSub;
using Narya.Twitch.Oauth;
using Narya.Twitch.Tokens;

namespace Narya.Api.Controllers;

/// <summary>
/// Twitch OAuth for the broadcaster ("user") and bot accounts. Every route except
/// <see cref="Callback"/> is deliberately absent from
/// <see cref="DashboardTokenMiddleware.OverlayPaths"/>, so the middleware already rejects an
/// overlay-token caller with 403 before any action here runs — mirrors
/// <see cref="ConfigController"/>. <see cref="Callback"/> is the one exception: it is listed
/// in <see cref="DashboardTokenMiddleware.ExemptPaths"/> because Twitch redirects the
/// operator's browser back to it with no way to attach a dashboard token; it authenticates
/// itself instead via the short-lived <see cref="StateCookieName"/> cookie <see cref="Authorize"/>
/// set. Port of <c>legacy/src/server/twitch/auth.ts</c>.
/// </summary>
[ApiController]
[Route("api/auth/twitch")]
public sealed partial class TwitchAuthController(
  IAppConfigStore appConfigStore,
  ITwitchOAuthClient oauthClient,
  ITwitchTokenStore tokenStore,
  ITwitchEventSource eventSource,
  ITwitchIdentityInvalidator identityInvalidator,
  IOptions<NaryaAuthOptions> authOptions,
  ILogger<TwitchAuthController> logger) : ControllerBase
{
  public const string StateCookieName = "narya_twitch_oauth_state";

  private const string CallbackPath = "/api/auth/twitch/callback";
  private const string AuthorizeEndpoint = "https://id.twitch.tv/oauth2/authorize";

  private readonly NaryaAuthOptions _authOptions = authOptions.Value;

  [HttpGet]
  public Task<IActionResult> Authorize(CancellationToken cancellationToken) =>
    StartLoginAsync(TwitchProvider.Broadcaster, cancellationToken);

  [HttpGet("bot")]
  public Task<IActionResult> AuthorizeBot(CancellationToken cancellationToken) =>
    StartLoginAsync(TwitchProvider.Bot, cancellationToken);

  /// <summary>
  /// Exempt from the dashboard-token check (see <see cref="DashboardTokenMiddleware.ExemptPaths"/>)
  /// — Twitch's redirect back here carries no dashboard token, so this route authenticates
  /// itself via <see cref="StateCookieName"/> instead: the cookie's value must match the guid
  /// half of the <c>state</c> query parameter <see cref="Authorize"/> minted.
  /// </summary>
  [HttpGet("callback")]
  public async Task<IActionResult> Callback(
    [FromQuery] string? code,
    [FromQuery] string? error,
    [FromQuery] string? state,
    CancellationToken cancellationToken)
  {
    var cookieState = Request.Cookies[StateCookieName];

    // Cleared unconditionally, on every outcome — a one-time login attempt must not leave a
    // stale state cookie usable by a later request.
    Response.Cookies.Delete(StateCookieName, new CookieOptions { Path = CallbackPath });

    if (!string.IsNullOrEmpty(error) || string.IsNullOrEmpty(code))
    {
      return BadRequest($"Twitch OAuth error: {error ?? "missing code"}");
    }

    var provider = ResolveProviderFromState(state, cookieState);
    if (provider is null)
    {
      return BadRequest("Twitch OAuth error: invalid state");
    }

    var exchangeResult = await oauthClient.ExchangeCodeAsync(code, _authOptions.TwitchRedirectUri, cancellationToken)
      .ConfigureAwait(false);
    if (exchangeResult.IsFailed)
    {
      return StatusCode(StatusCodes.Status500InternalServerError, new
      {
        error = $"Token exchange failed: {string.Join("; ", exchangeResult.Errors.Select(e => e.Message))}",
      });
    }

    var response = exchangeResult.Value;
    var token = new TwitchToken
    {
      AccessToken = response.AccessToken!,
      RefreshToken = response.RefreshToken,
      Scopes = response.Scope ?? ScopesFor(provider.Value),
      TokenType = response.TokenType,
      ExpiresAt = DateTimeOffset.UtcNow + TimeSpan.FromSeconds(Math.Max(60, response.ExpiresIn ?? 3600)),
    };

    var saveResult = await tokenStore.SaveAsync(provider.Value, token, cancellationToken).ConfigureAwait(false);
    if (saveResult.IsFailed)
    {
      return StatusCode(StatusCodes.Status500InternalServerError, new
      {
        error = $"Failed to save the Twitch token: {string.Join("; ", saveResult.Errors.Select(e => e.Message))}",
      });
    }

    // Both providers, not just the broadcaster. A broadcaster reauth can point at a different
    // channel (new broadcaster id, new subscription conditions) and grants scopes the live
    // socket needs fresh subscriptions for. A bot reauth is the security-relevant one: the
    // bot-loop guard suppresses chat messages matching the cached bot login, so reconnecting a
    // DIFFERENT bot account without clearing that cache leaves the guard comparing against the
    // previous bot — the new bot stops recognizing its own messages and answers itself.
    //
    // Best-effort: the token is already saved, so a failure here must never fail the callback.
    // The invalidator swallows and logs per-cache failures itself; this catch is the outer
    // backstop for anything it cannot (resolution, cancellation on shutdown).
    try
    {
      await identityInvalidator.InvalidateAsync(cancellationToken).ConfigureAwait(false);
    }
    catch (Exception ex)
    {
      LogEventSubReconnectFailed(logger, ex);
    }

    return Redirect("/");
  }

  [HttpGet("status")]
  public async Task<IActionResult> Status(CancellationToken cancellationToken)
  {
    var statusResult = await BuildStatusAsync(cancellationToken).ConfigureAwait(false);
    return statusResult.IsFailed
      ? StatusCode(StatusCodes.Status500InternalServerError, new { errors = statusResult.Errors.Select(e => e.Message) })
      : Ok(statusResult.Value);
  }

  [HttpDelete]
  public Task<IActionResult> SignOut(CancellationToken cancellationToken) =>
    SignOutProviderAsync(TwitchProvider.Broadcaster, cancellationToken);

  [HttpDelete("bot")]
  public Task<IActionResult> SignOutBot(CancellationToken cancellationToken) =>
    SignOutProviderAsync(TwitchProvider.Bot, cancellationToken);

  private async Task<IActionResult> StartLoginAsync(TwitchProvider provider, CancellationToken cancellationToken)
  {
    var configResult = await appConfigStore.GetAsync(cancellationToken).ConfigureAwait(false);
    if (configResult.IsFailed)
    {
      return StatusCode(StatusCodes.Status500InternalServerError, new { errors = configResult.Errors.Select(e => e.Message) });
    }

    var clientId = configResult.Value.TwitchClientId;
    if (string.IsNullOrWhiteSpace(clientId))
    {
      return StatusCode(StatusCodes.Status500InternalServerError, "TWITCH_CLIENT_ID not configured");
    }

    var oauthState = Guid.NewGuid().ToString();
    Response.Cookies.Append(StateCookieName, oauthState, new CookieOptions
    {
      HttpOnly = true,
      SameSite = SameSiteMode.Lax,
      Secure = Request.IsHttps,
      Path = CallbackPath,
      MaxAge = TimeSpan.FromSeconds(600),
    });

    var accountValue = AccountValueFor(provider);
    var queryParams = new Dictionary<string, string?>
    {
      ["client_id"] = clientId,
      ["redirect_uri"] = _authOptions.TwitchRedirectUri,
      ["response_type"] = "code",
      ["scope"] = string.Join(' ', ScopesFor(provider)),
      ["state"] = $"{accountValue}:{oauthState}",
    };

    if (Request.Query["force"] == "1")
    {
      queryParams["force_verify"] = "true";
    }

    return Redirect(QueryHelpers.AddQueryString(AuthorizeEndpoint, queryParams));
  }

  private async Task<IActionResult> SignOutProviderAsync(TwitchProvider provider, CancellationToken cancellationToken)
  {
    var deleteResult = await tokenStore.DeleteAsync(provider, cancellationToken).ConfigureAwait(false);
    if (deleteResult.IsFailed)
    {
      return StatusCode(StatusCodes.Status500InternalServerError, new { errors = deleteResult.Errors.Select(e => e.Message) });
    }

    if (provider == TwitchProvider.Broadcaster)
    {
      // Best-effort, same rationale as the callback's reconnect — the token is already gone
      // either way, so a disconnect failure must not turn a successful sign-out into an error.
      try
      {
        await eventSource.StopAsync().ConfigureAwait(false);
      }
      catch (Exception ex)
      {
        LogEventSubStopFailed(logger, ex);
      }
    }

    // SYMMETRIC WITH THE CALLBACK, and for the same reasons — deleting the token is not what
    // makes the identity stale, it is what makes the CACHED identity a lie. Every cache below
    // outlives the token it was derived from:
    //
    // - TwitchEventSubService._cachedBotLogin. The security-relevant one, and the reason this is
    //   a defect rather than a tidiness issue: the bot-loop guard suppresses any chat message
    //   whose author matches that login. After disconnecting the bot, a stale value keeps
    //   silently filtering messages from that login — so a VIEWER who happens to use the
    //   disconnected bot's name is invisible, with no error anywhere to explain it.
    // - HelixClient._authenticatedUserIds / _cachedBroadcasterId and
    //   TwitchCredentials._appToken / _cachedBroadcasterId. The app token is minted from
    //   client credentials, not from the deleted user token, so it keeps working: Helix calls
    //   keep succeeding against a channel the operator believes they disconnected.
    //
    // Both providers, not just the one signed out — same as the callback. The two caches are not
    // partitioned by provider (one broadcaster id, one app token, one bot login), so there is no
    // narrower invalidation to make.
    //
    // Best-effort: the token is already deleted, so a failure here must never turn a successful
    // sign-out into a 500. The invalidator swallows and logs per-cache failures itself; this
    // catch is the outer backstop for anything it cannot.
    try
    {
      await identityInvalidator.InvalidateAsync(cancellationToken).ConfigureAwait(false);
    }
    catch (Exception ex)
    {
      LogEventSubReconnectFailed(logger, ex);
    }

    var statusResult = await BuildStatusAsync(cancellationToken).ConfigureAwait(false);
    if (statusResult.IsFailed)
    {
      return StatusCode(StatusCodes.Status500InternalServerError, new { errors = statusResult.Errors.Select(e => e.Message) });
    }

    var status = statusResult.Value;
    return Ok(new
    {
      ok = true,
      status.TwitchAuthenticated,
      status.TwitchAuthSource,
      status.TwitchTokenExpiresAt,
      status.TwitchMissingScopes,
      status.TwitchBotAuthenticated,
      status.TwitchBotAuthSource,
      status.TwitchBotTokenExpiresAt,
      status.TwitchBotMissingScopes,
    });
  }

  private async Task<Result<TwitchAuthStatus>> BuildStatusAsync(CancellationToken cancellationToken)
  {
    var broadcasterResult = await tokenStore.GetAsync(TwitchProvider.Broadcaster, cancellationToken).ConfigureAwait(false);
    if (broadcasterResult.IsFailed)
    {
      return Result.Fail<TwitchAuthStatus>(broadcasterResult.Errors);
    }

    var botResult = await tokenStore.GetAsync(TwitchProvider.Bot, cancellationToken).ConfigureAwait(false);
    if (botResult.IsFailed)
    {
      return Result.Fail<TwitchAuthStatus>(botResult.Errors);
    }

    var broadcaster = broadcasterResult.Value;
    var bot = botResult.Value;

    return Result.Ok(new TwitchAuthStatus
    {
      TwitchAuthenticated = broadcaster is not null,
      TwitchAuthSource = broadcaster is not null ? "oauth" : null,
      TwitchTokenExpiresAt = broadcaster?.ExpiresAt,
      TwitchMissingScopes = broadcaster is null ? [] : MissingScopes(broadcaster.Scopes, Scopes.Broadcaster),
      TwitchBotAuthenticated = bot is not null,
      TwitchBotAuthSource = bot is not null ? "oauth" : null,
      TwitchBotTokenExpiresAt = bot?.ExpiresAt,
      TwitchBotMissingScopes = bot is null ? [] : MissingScopes(bot.Scopes, Scopes.Bot),
    });
  }

  /// <summary>
  /// Splits <paramref name="state"/> on the first <c>:</c> into an account + guid and
  /// validates both: the account must be a recognized value, and the guid must equal
  /// <paramref name="cookieState"/> exactly — a missing cookie (expired, or never set) fails
  /// the same as a mismatched one.
  /// </summary>
  private static TwitchProvider? ResolveProviderFromState(string? state, string? cookieState)
  {
    if (string.IsNullOrEmpty(state) || string.IsNullOrEmpty(cookieState))
    {
      return null;
    }

    var parts = state.Split(':', 2);
    var guidMatches = parts.Length == 2
      && !string.IsNullOrEmpty(parts[1])
      && string.Equals(parts[1], cookieState, StringComparison.Ordinal);

    return guidMatches
      ? parts[0] switch
      {
        "user" => TwitchProvider.Broadcaster,
        "bot" => TwitchProvider.Bot,
        _ => null,
      }
      : null;
  }

  private static string AccountValueFor(TwitchProvider provider) =>
    provider == TwitchProvider.Bot ? "bot" : "user";

  private static IReadOnlyList<string> ScopesFor(TwitchProvider provider) =>
    provider == TwitchProvider.Bot ? Scopes.Bot : Scopes.Broadcaster;

  /// <summary>
  /// The set difference <paramref name="required"/> minus <paramref name="tokenScopes"/> — a
  /// pure computation kept local to this controller rather than routed through
  /// <see cref="ITwitchCredentials"/>, so the status/sign-out routes depend on nothing beyond
  /// the four services already substituted in <c>TwitchAuthControllerTests</c>.
  /// </summary>
  private static IReadOnlyList<string> MissingScopes(IReadOnlyList<string> tokenScopes, IReadOnlyList<string> required) =>
    [.. required.Except(tokenScopes)];

  [LoggerMessage(Level = LogLevel.Warning, Message = "Twitch EventSub reconnect after OAuth callback failed")]
  private static partial void LogEventSubReconnectFailed(ILogger logger, Exception exception);

  [LoggerMessage(Level = LogLevel.Warning, Message = "Twitch EventSub stop after broadcaster sign-out failed")]
  private static partial void LogEventSubStopFailed(ILogger logger, Exception exception);
}
