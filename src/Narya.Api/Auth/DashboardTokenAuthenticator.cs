using System.Security.Cryptography;
using System.Text;

using Microsoft.Extensions.Options;

namespace Narya.Api.Auth;

/// <summary>
/// The operator/overlay token→role resolution, extracted out of
/// <see cref="DashboardTokenMiddleware"/> so <see cref="Narya.Api.Realtime.RealtimeHub"/>
/// can authenticate a SignalR connection with exactly the same rule instead of
/// re-deriving it. Registered as a singleton (Program.cs) — the dashboard token cannot
/// change at runtime in this host, so the overlay token is derived once here rather than
/// per resolution, same trade-off the middleware made before this extraction.
/// </summary>
public sealed class DashboardTokenAuthenticator(IOptions<NaryaAuthOptions> options)
{
  public const string OperatorRole = "operator";
  public const string OverlayRole = "overlay";

  private readonly string _dashboardToken = options.Value.DashboardToken;

  private readonly string? _overlayToken = string.IsNullOrEmpty(options.Value.DashboardToken)
    ? null
    : OverlayToken.Derive(options.Value.DashboardToken);

  /// <summary>
  /// False means no dashboard token is configured at all. <see cref="ResolveRole"/>
  /// always returns null in that state — callers that need the "no token configured"
  /// loopback fallback (currently only <see cref="DashboardTokenMiddleware"/>) check this
  /// first and apply their own fallback; a SignalR connection has no comparable notion of
  /// "loopback caller" to fall back to, so <see cref="Narya.Api.Realtime.RealtimeHub"/>
  /// treats a null role as unauthenticated outright.
  /// </summary>
  public bool HasDashboardToken => !string.IsNullOrEmpty(_dashboardToken);

  /// <summary>
  /// Resolves <paramref name="provided"/> against the configured operator/overlay tokens
  /// using constant-time comparison. Returns <see cref="OperatorRole"/>,
  /// <see cref="OverlayRole"/>, or null (no token configured, no token provided, or the
  /// provided token matches neither).
  /// </summary>
  public string? ResolveRole(string? provided) => (HasDashboardToken, provided) switch
  {
    (false, _) or (_, null) => null,
    _ when TokensMatch(provided, _dashboardToken) => OperatorRole,
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
}
