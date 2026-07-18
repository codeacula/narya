using System.Net;

using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.HttpOverrides;

namespace Narya.Api.Auth;

/// <summary>
/// Translates the <c>Narya:TrustedProxies</c> config list into
/// <see cref="ForwardedHeadersOptions"/>.
///
/// <para>
/// The point of forwarded-header processing here is that
/// <see cref="DashboardTokenMiddleware"/>'s loopback decision must be made against the REAL
/// client, not against a same-host reverse proxy's loopback peer address. That only holds if the
/// header is trusted from the proxy and nobody else, so this replaces ASP.NET's implicit
/// <c>::1</c>/<c>127.0.0.0/8</c> defaults with an explicit allowlist.
/// </para>
///
/// <para>
/// The allowlist defaults to EMPTY and empty means TRUST NO PROXY. Note that this cannot be
/// expressed by clearing <c>KnownProxies</c>/<c>KnownIPNetworks</c>: ASP.NET reads two empty
/// lists as "accept forwarded headers from ANY proxy", i.e. fail-OPEN, which is precisely the
/// bypass being closed here. The fail-closed encoding is therefore to not install
/// <c>UseForwardedHeaders</c> at all when <see cref="Read"/> comes back empty — see Program.cs.
/// </para>
/// </summary>
public static class TrustedProxies
{
  /// <summary>Config key holding the allowlist (an array of IP addresses and/or CIDR ranges).</summary>
  public const string ConfigKey = "Narya:TrustedProxies";

  /// <summary>
  /// The configured allowlist, or an empty array when the key is absent. An empty result means
  /// forwarded-header processing must stay switched off entirely (see this class's doc comment).
  /// </summary>
  public static string[] Read(IConfiguration configuration) =>
  [
    .. (configuration.GetSection(ConfigKey).Get<string[]>() ?? [])
      .Select(entry => entry.Trim())
      .Where(entry => entry.Length > 0),
  ];

  /// <summary>
  /// Entries containing <c>/</c> are parsed as CIDR networks, everything else as a single
  /// address. A malformed entry throws at startup rather than being skipped — silently dropping
  /// it would leave the operator believing a proxy is trusted when it is not (or, worse, believing
  /// the deployment is locked down when the entry that was supposed to narrow it never applied).
  /// </summary>
  public static void Configure(ForwardedHeadersOptions options, IEnumerable<string> allowlist)
  {
    options.ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto;

    options.KnownProxies.Clear();
    options.KnownIPNetworks.Clear();

    var entries = allowlist.Select(value => value.Trim()).Where(value => value.Length > 0).ToList();
    if (entries.Count == 0)
    {
      // Would leave both Known* lists empty, which ASP.NET reads as "trust any proxy". Callers
      // must skip UseForwardedHeaders entirely in that state; reaching here means they did not.
      throw new InvalidOperationException(
        $"'{ConfigKey}' is empty — forwarded-header processing must be left off entirely rather " +
        "than configured with an empty allowlist, which ASP.NET treats as trusting every proxy.");
    }

    foreach (var entry in entries)
    {
      if (entry.Contains('/', StringComparison.Ordinal))
      {
        options.KnownIPNetworks.Add(ParseNetwork(entry));
        continue;
      }

      options.KnownProxies.Add(ParseAddress(entry));
    }
  }

  /// <summary>
  /// Fully qualified: <c>Microsoft.AspNetCore.HttpOverrides</c> defines its own (deprecated)
  /// <c>IPNetwork</c>, and <c>ForwardedHeadersOptions.KnownIPNetworks</c> is typed on the
  /// <see cref="System.Net.IPNetwork"/> one.
  /// </summary>
  private static System.Net.IPNetwork ParseNetwork(string entry) =>
    System.Net.IPNetwork.TryParse(entry, out var network)
      ? network
      : throw new InvalidOperationException($"'{ConfigKey}' contains an invalid CIDR range: '{entry}'.");

  private static IPAddress ParseAddress(string entry) =>
    IPAddress.TryParse(entry, out var address)
      ? address
      : throw new InvalidOperationException($"'{ConfigKey}' contains an invalid IP address: '{entry}'.");
}
