using System.Net;

using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;

namespace Narya.Api.Auth;

/// <summary>
/// Refuses to serve a non-loopback binding with no <c>Narya:DashboardToken</c> configured.
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
/// </summary>
public static class StartupBindingGuard
{
  /// <summary>Named in the failure message so the operator knows exactly what to set.</summary>
  public const string DashboardTokenConfigKey = "Narya:DashboardToken";

  /// <summary>
  /// Reads the effective bound addresses from <see cref="IServerAddressesFeature"/> — not from
  /// configuration — so a <c>--urls</c> argument or an <c>ASPNETCORE_URLS</c> environment
  /// variable cannot slip past the check.
  /// </summary>
  public static void Validate(IServiceProvider services, string? dashboardToken)
  {
    var addresses = services.GetService<IServer>()?.Features.Get<IServerAddressesFeature>()?.Addresses;
    Validate(addresses ?? [], dashboardToken);
  }

  /// <summary>
  /// Throws <see cref="InvalidOperationException"/> naming the offending binding and the config
  /// key when <paramref name="dashboardToken"/> is absent/empty and any address in
  /// <paramref name="addresses"/> is not loopback. A loopback-only bind with no token is the
  /// supported local-dev path and passes.
  /// </summary>
  public static void Validate(IEnumerable<string> addresses, string? dashboardToken)
  {
    if (!string.IsNullOrEmpty(dashboardToken))
    {
      return;
    }

    var offending = addresses.FirstOrDefault(address => !IsLoopbackAddress(address));
    if (offending is null)
    {
      return;
    }

    throw new InvalidOperationException(
      $"Refusing to start: the server is bound to '{offending}', which is not a loopback address, " +
      $"and no operator token is configured. Set '{DashboardTokenConfigKey}', or bind only " +
      "loopback (http://localhost:5000).");
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
