namespace Narya.Api.Auth;

/// <summary>
/// Port of legacy <c>requireDashboardToken</c> (<c>legacy/src/server/auth.ts</c>).
/// Mounted only over <c>/api</c> in Program.cs — static/SPA assets are not gated.
///
/// Two capabilities share one secret. The operator token is full control. The
/// overlay token (see <see cref="OverlayToken"/>) is read-only over a small
/// allowlist: an OBS browser source URL is a long-lived, plainly visible
/// credential, so it must not be able to reach anything beyond what an overlay
/// needs to render itself.
///
/// Token→role resolution — including the no-token loopback fallback
/// (<see cref="DashboardTokenAuthenticator.ResolveLoopbackRole"/>) — lives in
/// <see cref="DashboardTokenAuthenticator"/> (shared with
/// <see cref="Narya.Api.Realtime.RealtimeHub"/>); this class owns only the HTTP-specific
/// concerns: extracting the token from the request, the overlay path allowlist, and the
/// response shapes.
///
/// <para>
/// This middleware does NOT by itself reproduce legacy's rule that a non-loopback deployment
/// must have a token. Legacy enforced that by refusing to BIND at startup, and a per-request
/// peer-address check cannot substitute for it: behind a same-host reverse proxy every
/// forwarded request has a loopback peer address. <see cref="StartupBindingGuard"/> is what
/// ports the startup rule, and <see cref="TrustedProxies"/> is what makes the peer address
/// reflect the real client. All three are required together.
/// </para>
/// </summary>
public sealed class DashboardTokenMiddleware(RequestDelegate next, DashboardTokenAuthenticator authenticator)
{
  public const string RoleItemKey = "narya:role";
  public const string OperatorRole = DashboardTokenAuthenticator.OperatorRole;
  public const string OverlayRole = DashboardTokenAuthenticator.OverlayRole;

  /// <summary>
  /// Everything an overlay browser source is allowed to GET. Phase 1 shipped only
  /// <c>/api/health</c>; Phase 3 Task 1 adds <c>/api/chat/recent</c> (the chat overlay seeds
  /// itself from it before <c>chat:message</c> broadcasts start arriving — matches legacy's
  /// <c>OVERLAY_PATHS</c> in legacy/src/server/auth.ts); Phase 3 Task 7 adds
  /// <c>/api/dashboard/session-shoutouts</c> (the <c>/overlay/shoutouts</c> ticker seeds itself
  /// the same way). The rest of the full legacy allowlist is reproduced here so later phases add
  /// to this set as each endpoint ships, rather than re-deriving it:
  ///   /api/emotes, /api/music/current, /api/sounds, /api/clips,
  ///   /api/stream-status, /api/overlay/placeholders
  /// <c>/api/config</c>, <c>/api/chat/events/recent</c> (raw event payloads, including moderation
  /// reasons), and <c>/api/dashboard/status</c> (auth token expiry, EventSub error detail) are
  /// deliberately never on this list.
  /// </summary>
  public static readonly HashSet<string> OverlayPaths = new(StringComparer.Ordinal)
  {
    "/api/health",
    "/api/chat/recent",
    "/api/dashboard/session-shoutouts",
  };

  /// <summary>
  /// Paths that skip the dashboard-token check entirely, regardless of method or role —
  /// unlike <see cref="OverlayPaths"/>, which still requires a valid overlay token. The only
  /// member is the Twitch OAuth callback: Twitch redirects the operator's browser back here
  /// with no way to attach a dashboard token, so the request is authenticated instead by the
  /// short-lived, httpOnly <c>narya_twitch_oauth_state</c> cookie the authorize step set
  /// (mirrors legacy's <c>OAUTH_EXEMPT_PATHS</c> in <c>legacy/src/server/auth.ts</c>). Keep
  /// this set to exactly the routes that are self-authenticating some other way — anything
  /// else added here bypasses the dashboard token altogether.
  /// </summary>
  public static readonly HashSet<string> ExemptPaths = new(StringComparer.Ordinal)
  {
    "/api/auth/twitch/callback",
  };

  private readonly RequestDelegate _next = next;
  private readonly DashboardTokenAuthenticator _authenticator = authenticator;

  public async Task InvokeAsync(HttpContext context)
  {
    if (ExemptPaths.Contains(context.Request.Path.Value ?? string.Empty))
    {
      await _next(context).ConfigureAwait(false);
      return;
    }

    if (!_authenticator.HasDashboardToken)
    {
      // No token configured: StartupBindingGuard has already proven the process is bound to
      // loopback only, so a loopback caller here is a genuinely local one.
      if (_authenticator.ResolveLoopbackRole(context.Connection.RemoteIpAddress) == OperatorRole)
      {
        context.Items[RoleItemKey] = OperatorRole;
        await _next(context).ConfigureAwait(false);
        return;
      }

      await WriteForbidden(context, "Forbidden: no dashboard token configured and caller is not loopback")
        .ConfigureAwait(false);
      return;
    }

    var provided = ExtractToken(context.Request);
    var role = _authenticator.ResolveRole(provided);

    if (role == OperatorRole)
    {
      context.Items[RoleItemKey] = OperatorRole;
      await _next(context).ConfigureAwait(false);
      return;
    }

    if (role == OverlayRole)
    {
      if (HttpMethods.IsGet(context.Request.Method) && OverlayPaths.Contains(context.Request.Path.Value ?? string.Empty))
      {
        context.Items[RoleItemKey] = OverlayRole;
        await _next(context).ConfigureAwait(false);
        return;
      }

      await WriteForbidden(context, "Forbidden: overlay token").ConfigureAwait(false);
      return;
    }

    // The code says "the token you presented is the problem" — a bare 401 is
    // ambiguous with routes that 401 over a missing Twitch login elsewhere, and
    // the client uses this code to decide whether to discard its stored token.
    await WriteUnauthorized(context).ConfigureAwait(false);
  }

  private static string? ExtractToken(HttpRequest request)
  {
    var authHeader = request.Headers.Authorization.ToString();
    if (authHeader.StartsWith("Bearer ", StringComparison.Ordinal))
    {
      var bearer = authHeader["Bearer ".Length..].Trim();
      if (bearer.Length > 0)
      {
        return bearer;
      }
    }

    var headerToken = request.Headers["X-Dashboard-Token"].ToString();
    if (!string.IsNullOrEmpty(headerToken))
    {
      return headerToken;
    }

    var queryToken = request.Query["token"].ToString();
    return string.IsNullOrEmpty(queryToken) ? null : queryToken;
  }

  private static Task WriteUnauthorized(HttpContext context)
  {
    context.Response.StatusCode = StatusCodes.Status401Unauthorized;
    return context.Response.WriteAsJsonAsync(new { error = "Unauthorized", code = "INVALID_DASHBOARD_TOKEN" });
  }

  /// <summary>
  /// <paramref name="reason"/> is caller-supplied rather than a fixed string: the two call
  /// sites are different failures (no token configured and a non-loopback caller; an
  /// overlay token reaching a path outside its allowlist) and a fixed "overlay token"
  /// message previously claimed an overlay token was involved even for the no-token case.
  /// </summary>
  private static Task WriteForbidden(HttpContext context, string reason)
  {
    context.Response.StatusCode = StatusCodes.Status403Forbidden;
    return context.Response.WriteAsJsonAsync(new { error = reason });
  }
}
