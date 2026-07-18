using System.Net;

namespace Narya.Api.Auth;

/// <summary>
/// Refuses to serve any deployment that has no <c>Narya:DashboardToken</c> configured and has not
/// proven itself to be a genuinely local, loopback-only, proxy-free one.
///
/// <para>
/// This is the piece legacy actually enforced and the C# port originally dropped: legacy's
/// server refused to BIND a non-loopback address when no token was set, which is a STARTUP
/// decision. <see cref="DashboardTokenMiddleware"/>'s per-request loopback check cannot
/// reproduce it — behind a same-host reverse proxy every forwarded request arrives from a
/// loopback peer, so a per-request check alone hands full operator access to the entire
/// internet. The per-request check remains (it is what makes a genuine localhost-only dev run
/// usable with no token); this guard is what makes it safe.
/// </para>
///
/// <para>
/// The rule is deliberately stricter than "non-loopback binding needs a token". The planned
/// deployment is a same-host reverse proxy, which binds LOOPBACK ONLY — so a binding-only check
/// passes on exactly the configuration it exists to stop. Three things therefore refuse to start
/// when no token is configured: a non-loopback binding, a declared <see cref="TrustedProxies"/>
/// allowlist (a declared proxy deployment is by definition not loopback-only), and the absence of
/// the explicit <see cref="AllowLoopbackOperatorWithoutTokenConfigKey"/> opt-in. The last one is
/// what makes the SHIPPED DEFAULT of "set nothing at all" fail closed instead of open.
/// </para>
///
/// <para>
/// Runs from <see cref="StartupBindingGuardFilter"/>, i.e. while the request pipeline is being
/// built and BEFORE the server binds its socket, so an unsafe deployment never accepts a single
/// connection rather than serving requests for the length of a start/stop cycle.
/// </para>
/// </summary>
public static class StartupBindingGuard
{
  /// <summary>Named in every failure message so the operator knows exactly what to set.</summary>
  public const string DashboardTokenConfigKey = "Narya:DashboardToken";

  /// <summary>
  /// Explicit opt-in to running with no operator token at all. Its absence is what makes an
  /// unconfigured deployment refuse to start.
  /// </summary>
  public const string AllowLoopbackOperatorWithoutTokenConfigKey =
    "Narya:AllowLoopbackOperatorWithoutToken";

  /// <summary>
  /// Throws <see cref="InvalidOperationException"/>, always naming
  /// <see cref="DashboardTokenConfigKey"/>, when <paramref name="dashboardToken"/> is
  /// absent/empty and any of the three unsafe conditions in this class's doc comment holds. A
  /// loopback-only bind with no proxy allowlist and the explicit opt-in set is the supported
  /// local-dev path and passes.
  ///
  /// <para>
  /// <paramref name="addresses"/> comes from the server's <c>IServerAddressesFeature</c> (see
  /// <see cref="StartupBindingGuardFilter"/>) rather than from configuration, so a <c>--urls</c>
  /// argument or an <c>ASPNETCORE_URLS</c> environment variable cannot slip past the check.
  /// </para>
  /// </summary>
  public static void Validate(
    IEnumerable<string> addresses,
    string? dashboardToken,
    IReadOnlyCollection<string> trustedProxies,
    bool allowLoopbackOperatorWithoutToken)
  {
    if (!string.IsNullOrEmpty(dashboardToken))
    {
      return;
    }

    // Checked first because it names a concrete offending binding, which is the most actionable
    // message when more than one of these conditions holds at once.
    var offending = addresses.FirstOrDefault(address => !IsLoopbackAddress(address));
    if (offending is not null)
    {
      throw new InvalidOperationException(
        $"Refusing to start: the server is bound to '{offending}', which is not a loopback " +
        $"address, and no operator token is configured. Set '{DashboardTokenConfigKey}', or bind " +
        "only loopback (http://localhost:5000).");
    }

    // The reverse-proxy case the binding check above cannot see: a same-host proxy deployment
    // binds loopback only, so without this it would pass the binding check and then hand every
    // request the proxy relays — i.e. the whole internet — the loopback operator role.
    if (trustedProxies.Count > 0)
    {
      throw new InvalidOperationException(
        $"Refusing to start: '{TrustedProxies.ConfigKey}' declares a reverse proxy " +
        $"({string.Join(", ", trustedProxies)}) but no operator token is configured. A deployment " +
        "fronted by a proxy is not loopback-only — every request it relays arrives from a " +
        $"loopback peer — so '{DashboardTokenConfigKey}' is required.");
    }

    if (!allowLoopbackOperatorWithoutToken)
    {
      throw new InvalidOperationException(
        "Refusing to start: no operator token is configured. Set " +
        $"'{DashboardTokenConfigKey}', or — only for a genuinely local, proxy-free run — set " +
        $"'{AllowLoopbackOperatorWithoutTokenConfigKey}' to true to accept that every loopback " +
        "caller gets full operator access.");
    }
  }

  /// <summary>
  /// A binding string is loopback only when its host is verifiably loopback. Anything that
  /// cannot be parsed, and every wildcard host (<c>*</c>, <c>+</c>, <c>0.0.0.0</c>, <c>[::]</c>),
  /// fails CLOSED — treated as non-loopback — for the same reason
  /// <see cref="DashboardTokenMiddleware"/> refuses to treat a null remote address as loopback.
  /// </summary>
  private static bool IsLoopbackAddress(string address)
  {
    if (!Uri.TryCreate(address, UriKind.Absolute, out var uri))
    {
      return false;
    }

    var host = uri.Host;
    if (string.Equals(host, "localhost", StringComparison.OrdinalIgnoreCase))
    {
      return true;
    }

    // Uri strips the brackets from an IPv6 literal host, so this parses "::1" directly.
    return IPAddress.TryParse(host, out var ip) && IPAddress.IsLoopback(ip);
  }
}
