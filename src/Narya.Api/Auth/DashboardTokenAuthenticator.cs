using System.Net;
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
  /// False means no dashboard token is configured at all. <see cref="ResolveRole"/> always
  /// returns null in that state; <see cref="ResolveLoopbackRole"/> is the fallback both the
  /// HTTP middleware and the SignalR hub apply in that case.
  /// </summary>
  public bool HasDashboardToken => !string.IsNullOrEmpty(_dashboardToken);

  /// <summary>
  /// The "no token configured, so this deployment is loopback-only" fallback, shared by
  /// <see cref="DashboardTokenMiddleware"/> and <see cref="Narya.Api.Realtime.RealtimeHub"/> so
  /// the HTTP and SignalR paths cannot drift on it. Returns <see cref="OperatorRole"/> only when
  /// no dashboard token is configured AND <paramref name="remoteIp"/> is a verified loopback
  /// address; null otherwise.
  ///
  /// <para>
  /// Fails CLOSED on a null <paramref name="remoteIp"/> (e.g. Kestrel over a Unix domain socket):
  /// null is not loopback. What makes this fallback safe at all is
  /// <see cref="StartupBindingGuard"/> — with no token configured the process refuses to bind
  /// anything but loopback, so a loopback peer here really is a local caller and not a reverse
  /// proxy relaying the internet. <see cref="TrustedProxies"/> covers the remaining case where a
  /// proxy is deliberately allowlisted.
  /// </para>
  /// </summary>
  public string? ResolveLoopbackRole(IPAddress? remoteIp) =>
    !HasDashboardToken && remoteIp is not null && IPAddress.IsLoopback(remoteIp)
      ? OperatorRole
      : null;

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
