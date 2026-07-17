using System.Net;
using System.Security.Cryptography;
using System.Text;

using Microsoft.Extensions.Options;

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
/// </summary>
public sealed class DashboardTokenMiddleware(RequestDelegate next, IOptions<NaryaAuthOptions> options)
{
  public const string RoleItemKey = "narya:role";
  public const string OperatorRole = "operator";
  public const string OverlayRole = "overlay";

  /// <summary>
  /// Everything an overlay browser source is allowed to GET. Phase 1 ships only
  /// <c>/api/health</c>; the full legacy allowlist (<c>OVERLAY_PATHS</c> in
  /// legacy/src/server/auth.ts) is reproduced here so later phases add to this
  /// set as each endpoint ships, rather than re-deriving it:
  ///   /api/chat/recent, /api/emotes, /api/music/current, /api/sounds, /api/clips,
  ///   /api/stream-status, /api/dashboard/session-shoutouts, /api/overlay/placeholders
  /// <c>/api/config</c> is deliberately never on this list.
  /// </summary>
  public static readonly HashSet<string> OverlayPaths = new(StringComparer.Ordinal)
  {
    "/api/health",
  };

  private readonly RequestDelegate _next = next;
  private readonly NaryaAuthOptions _options = options.Value;

  /// <summary>
  /// Derived once at construction (this middleware is built once per app, not
  /// per request — same lifetime assumption the plain _options field above
  /// already relies on) rather than on every non-operator request. The
  /// dashboard token cannot change at runtime in this host (Settings PUT
  /// lands in a later phase and, per legacy precedent, reconnects rather
  /// than mutating IOptions in place), so re-deriving an HMAC per request
  /// bought nothing but hot-path cost.
  /// </summary>
  private readonly string? _overlayToken = string.IsNullOrEmpty(options.Value.DashboardToken)
    ? null
    : OverlayToken.Derive(options.Value.DashboardToken);

  public async Task InvokeAsync(HttpContext context)
  {
    var dashboardToken = _options.DashboardToken;

    if (string.IsNullOrEmpty(dashboardToken))
    {
      // No token configured: the deployment is assumed loopback-only (the
      // legacy server refuses to bind non-loopback with no token at startup;
      // here we enforce the same intent per-request instead).
      if (IsLoopback(context))
      {
        context.Items[RoleItemKey] = OperatorRole;
        await _next(context).ConfigureAwait(false);
        return;
      }

      await WriteForbidden(context).ConfigureAwait(false);
      return;
    }

    var provided = ExtractToken(context.Request);
    var role = ResolveRole(provided, dashboardToken);

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

      await WriteForbidden(context).ConfigureAwait(false);
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

  private string? ResolveRole(string? provided, string dashboardToken) => provided switch
  {
    null => null,
    _ when TokensMatch(provided, dashboardToken) => OperatorRole,
    _ when _overlayToken is not null && TokensMatch(provided, _overlayToken) => OverlayRole,
    _ => null,
  };

  private static bool TokensMatch(string provided, string expected)
  {
    var providedBytes = Encoding.UTF8.GetBytes(provided);
    var expectedBytes = Encoding.UTF8.GetBytes(expected);

    // FixedTimeEquals requires equal-length spans; a length mismatch is safe to
    // short-circuit on (still constant-time within a given expected length, same
    // trade-off the legacy timingSafeEqual wrapper makes).
    return providedBytes.Length == expectedBytes.Length
      && CryptographicOperations.FixedTimeEquals(providedBytes, expectedBytes);
  }

  private static bool IsLoopback(HttpContext context)
  {
    var remoteIp = context.Connection.RemoteIpAddress;
    // Fail CLOSED: a null remote address (e.g. Kestrel over a Unix domain
    // socket behind a reverse proxy — a common deployment) must NOT be
    // treated as loopback. Only a genuine, verified loopback address grants
    // operator access when no token is configured.
    return remoteIp is not null && IPAddress.IsLoopback(remoteIp);
  }

  private static Task WriteUnauthorized(HttpContext context)
  {
    context.Response.StatusCode = StatusCodes.Status401Unauthorized;
    return context.Response.WriteAsJsonAsync(new { error = "Unauthorized", code = "INVALID_DASHBOARD_TOKEN" });
  }

  private static Task WriteForbidden(HttpContext context)
  {
    context.Response.StatusCode = StatusCodes.Status403Forbidden;
    return context.Response.WriteAsJsonAsync(new { error = "Forbidden: overlay token" });
  }
}
