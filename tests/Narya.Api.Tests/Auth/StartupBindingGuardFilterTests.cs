using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

using Narya.Api.Auth;

namespace Narya.Api.Tests.Auth;

/// <summary>
/// The guard has to run while the pipeline is being BUILT, not after <c>app.StartAsync()</c>.
/// After start, Kestrel is already bound and accepting on the very address the guard exists to
/// reject, so an unsafe deployment serves requests for the length of a start/stop cycle — and a
/// served response cannot be un-served. These tests pin the filter's contract: it reads
/// <see cref="IServerAddressesFeature"/> off the builder, and it throws INSTEAD OF calling
/// <c>next</c>, so the pipeline is never completed and the socket is never opened.
/// </summary>
public sealed class StartupBindingGuardFilterTests
{
  private static ApplicationBuilder BuildAppBuilder(params string[] addresses)
  {
    var addressesFeature = new ServerAddressesFeature();
    foreach (var address in addresses)
    {
      addressesFeature.Addresses.Add(address);
    }

    var serverFeatures = new FeatureCollection();
    serverFeatures.Set<IServerAddressesFeature>(addressesFeature);

    return new ApplicationBuilder(new ServiceCollection().BuildServiceProvider(), serverFeatures);
  }

  private static StartupBindingGuardFilter BuildFilter(params (string Key, string Value)[] settings) =>
    new(new ConfigurationBuilder()
      .AddInMemoryCollection(settings.Select(s => new KeyValuePair<string, string?>(s.Key, s.Value)))
      .Build());

  /// <summary>
  /// The address the guard judges comes from the server's own feature, which is what a
  /// <c>--urls</c> argument or <c>ASPNETCORE_URLS</c> populates — configuration is not re-parsed,
  /// so neither can slip past.
  /// </summary>
  [Fact]
  public void ThrowsWithoutInvokingTheRestOfThePipelineForANonLoopbackBindingWithNoToken()
  {
    var nextWasCalled = false;
    var configure = BuildFilter().Configure(_ => nextWasCalled = true);

    var exception = Assert.Throws<InvalidOperationException>(
      () => configure(BuildAppBuilder("http://0.0.0.0:5000")));

    Assert.Contains("http://0.0.0.0:5000", exception.Message, StringComparison.Ordinal);
    Assert.False(nextWasCalled, "the pipeline must not be completed for a rejected deployment");
  }

  /// <summary>The shipped default — nothing configured — refuses even on a loopback binding.</summary>
  [Fact]
  public void ThrowsForALoopbackBindingWhenNothingIsConfiguredAtAll()
  {
    var nextWasCalled = false;
    var configure = BuildFilter().Configure(_ => nextWasCalled = true);

    var exception = Assert.Throws<InvalidOperationException>(
      () => configure(BuildAppBuilder("http://127.0.0.1:5000")));

    Assert.Contains(
      StartupBindingGuard.AllowLoopbackOperatorWithoutTokenConfigKey,
      exception.Message,
      StringComparison.Ordinal);
    Assert.False(nextWasCalled);
  }

  /// <summary>The same-host reverse proxy case: declaring a proxy requires a token.</summary>
  [Fact]
  public void ThrowsForALoopbackBindingWhenAProxyIsDeclaredWithNoToken()
  {
    var configure = BuildFilter(
      ($"{TrustedProxies.ConfigKey}:0", "127.0.0.1"),
      (StartupBindingGuard.AllowLoopbackOperatorWithoutTokenConfigKey, "true"))
      .Configure(_ => { });

    var exception = Assert.Throws<InvalidOperationException>(
      () => configure(BuildAppBuilder("http://127.0.0.1:5000")));

    Assert.Contains(TrustedProxies.ConfigKey, exception.Message, StringComparison.Ordinal);
  }

  [Fact]
  public void BuildsThePipelineForAnOptedInLoopbackOnlyDeployment()
  {
    var nextWasCalled = false;
    var configure = BuildFilter((StartupBindingGuard.AllowLoopbackOperatorWithoutTokenConfigKey, "true"))
      .Configure(_ => nextWasCalled = true);

    configure(BuildAppBuilder("http://localhost:5000"));

    Assert.True(nextWasCalled);
  }

  [Fact]
  public void BuildsThePipelineForATokenedProxyDeploymentOnAnyBinding()
  {
    var nextWasCalled = false;
    var configure = BuildFilter(
      (StartupBindingGuard.DashboardTokenConfigKey, "op-token"),
      ($"{TrustedProxies.ConfigKey}:0", "127.0.0.1"))
      .Configure(_ => nextWasCalled = true);

    configure(BuildAppBuilder("http://0.0.0.0:5000"));

    Assert.True(nextWasCalled);
  }
}
