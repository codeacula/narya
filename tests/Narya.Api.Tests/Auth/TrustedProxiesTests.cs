using System.Net;

using Microsoft.AspNetCore.Builder;
using Microsoft.Extensions.Configuration;

using Narya.Api.Auth;

namespace Narya.Api.Tests.Auth;

public sealed class TrustedProxiesTests
{
  private static IConfiguration Configuration(params (string Key, string Value)[] values) =>
    new ConfigurationBuilder()
      .AddInMemoryCollection(values.Select(pair => new KeyValuePair<string, string?>(pair.Key, pair.Value)))
      .Build();

  [Fact]
  public void UnconfiguredAllowlistReadsAsEmpty() =>
    Assert.Empty(TrustedProxies.Read(Configuration()));

  [Fact]
  public void BlankEntriesAreDroppedSoAnAllWhitespaceListStillReadsAsEmpty() =>
    Assert.Empty(TrustedProxies.Read(Configuration(
      ($"{TrustedProxies.ConfigKey}:0", "  "),
      ($"{TrustedProxies.ConfigKey}:1", ""))));

  [Fact]
  public void ConfiguredEntriesAreReadInOrderAndTrimmed() =>
    Assert.Equal(
      ["127.0.0.1", "10.0.0.0/8"],
      TrustedProxies.Read(Configuration(
        ($"{TrustedProxies.ConfigKey}:0", " 127.0.0.1 "),
        ($"{TrustedProxies.ConfigKey}:1", "10.0.0.0/8"))));

  /// <summary>
  /// The fail-closed contract. ASP.NET reads two empty <c>Known*</c> lists as "trust any proxy",
  /// so an empty allowlist must never be turned into options at all — Program.cs skips
  /// <c>UseForwardedHeaders</c> entirely instead, and this throw is what stops a future caller
  /// from quietly reintroducing the fail-open state.
  /// </summary>
  [Fact]
  public void ConfiguringAnEmptyAllowlistThrowsRatherThanTrustingEveryProxy() =>
    Assert.Throws<InvalidOperationException>(
      () => TrustedProxies.Configure(new ForwardedHeadersOptions(), []));

  [Fact]
  public void ConfigureReplacesAspNetsImplicitLoopbackDefaultsWithTheAllowlist()
  {
    var options = new ForwardedHeadersOptions();

    TrustedProxies.Configure(options, ["203.0.113.9", "10.0.0.0/8"]);

    Assert.Equal([IPAddress.Parse("203.0.113.9")], options.KnownProxies);
    Assert.Equal([System.Net.IPNetwork.Parse("10.0.0.0/8")], options.KnownIPNetworks);
  }

  [Theory]
  [InlineData("not-an-ip")]
  [InlineData("999.1.1.1")]
  public void AMalformedAddressThrowsRatherThanBeingSilentlySkipped(string entry) =>
    Assert.Throws<InvalidOperationException>(
      () => TrustedProxies.Configure(new ForwardedHeadersOptions(), [entry]));

  [Fact]
  public void AMalformedCidrRangeThrowsRatherThanBeingSilentlySkipped() =>
    Assert.Throws<InvalidOperationException>(
      () => TrustedProxies.Configure(new ForwardedHeadersOptions(), ["10.0.0.0/nope"]));
}
