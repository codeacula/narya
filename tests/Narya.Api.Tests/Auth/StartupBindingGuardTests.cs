using Narya.Api.Auth;

namespace Narya.Api.Tests.Auth;

/// <summary>
/// The startup half of the reverse-proxy bypass fix. <see cref="DashboardTokenMiddleware"/>'s
/// per-request loopback check cannot enforce "a no-token deployment must really be local" —
/// behind a same-host proxy every request has a loopback peer — so the rule lives here, and these
/// tests exercise the guard directly rather than through <c>WebApplicationFactory</c> (which runs
/// under <c>Narya:SkipInfrastructure</c>, where the guard is deliberately not registered).
/// </summary>
public sealed class StartupBindingGuardTests
{
  /// <summary>
  /// The supported local-dev shape: opted in, no proxy declared. Every test that is not about one
  /// of those two conditions uses it so the condition under test is the only thing varying.
  /// </summary>
  private static void ValidateLocalDev(IEnumerable<string> addresses, string? dashboardToken) =>
    StartupBindingGuard.Validate(
      addresses,
      dashboardToken,
      trustedProxies: [],
      allowLoopbackOperatorWithoutToken: true);

  [Theory]
  [InlineData("http://0.0.0.0:5000")]
  [InlineData("http://192.168.1.20:5000")]
  [InlineData("https://narya.example.com")]
  [InlineData("http://[::]:5000")]
  [InlineData("http://*:5000")]
  public void NonLoopbackBindingWithNoTokenThrowsNamingTheBindingAndConfigKey(string address)
  {
    var exception = Assert.Throws<InvalidOperationException>(
      () => ValidateLocalDev([address], dashboardToken: null));

    Assert.Contains(StartupBindingGuard.DashboardTokenConfigKey, exception.Message, StringComparison.Ordinal);
    Assert.Contains(address, exception.Message, StringComparison.Ordinal);
  }

  [Fact]
  public void EmptyTokenIsTreatedTheSameAsNoToken()
  {
    var exception = Assert.Throws<InvalidOperationException>(
      () => ValidateLocalDev(["http://0.0.0.0:5000"], dashboardToken: string.Empty));

    Assert.Contains(StartupBindingGuard.DashboardTokenConfigKey, exception.Message, StringComparison.Ordinal);
  }

  [Fact]
  public void OneNonLoopbackBindingAmongLoopbackOnesStillThrows() =>
    Assert.Throws<InvalidOperationException>(() => ValidateLocalDev(
      ["http://localhost:5000", "http://127.0.0.1:5001", "http://10.0.0.4:5002"],
      dashboardToken: null));

  [Theory]
  [InlineData("http://localhost:5000")]
  [InlineData("http://127.0.0.1:5000")]
  [InlineData("http://127.0.0.53:5000")]
  [InlineData("http://[::1]:5000")]
  public void LoopbackOnlyBindingWithNoTokenIsAllowedOnceOptedIn(string address) =>
    ValidateLocalDev([address], dashboardToken: null);

  [Fact]
  public void NoBindingsAtAllWithNoTokenIsAllowedOnceOptedIn() =>
    ValidateLocalDev([], dashboardToken: null);

  [Theory]
  [InlineData("http://0.0.0.0:5000")]
  [InlineData("https://narya.example.com")]
  [InlineData("http://localhost:5000")]
  public void AnyBindingIsAllowedOnceATokenIsConfigured(string address) =>
    StartupBindingGuard.Validate(
      [address],
      dashboardToken: "op-token",
      trustedProxies: ["127.0.0.1"],
      allowLoopbackOperatorWithoutToken: false);

  /// <summary>
  /// An address the guard cannot parse must fail CLOSED, the same way a null
  /// <c>RemoteIpAddress</c> does in <see cref="DashboardTokenMiddleware"/> — "I could not prove
  /// this is loopback" is not "this is loopback".
  /// </summary>
  [Fact]
  public void UnparseableBindingWithNoTokenThrows() =>
    Assert.Throws<InvalidOperationException>(
      () => ValidateLocalDev(["not a url at all"], dashboardToken: null));

  /// <summary>
  /// THE reverse-proxy case. The planned deployment binds LOOPBACK ONLY and puts nginx in front,
  /// so a binding-only check passes on exactly the configuration it exists to stop. Declaring a
  /// proxy allowlist is a declaration that this host is not loopback-only, so it requires a token.
  ///
  /// <para>
  /// Closing this also removes the "trusted proxy forwards a request carrying no
  /// <c>X-Forwarded-For</c>" hole: <c>ForwardedHeadersMiddleware</c> leaves
  /// <c>RemoteIpAddress</c> at the proxy's loopback address when the header is absent (nginx does
  /// not send it unless <c>proxy_set_header</c> says so), which would otherwise resolve to the
  /// operator role. With a token now mandatory whenever a proxy is declared, that configuration
  /// cannot start at all and the request-time path is unreachable.
  /// </para>
  /// </summary>
  [Theory]
  [InlineData("http://localhost:5000")]
  [InlineData("http://127.0.0.1:5000")]
  public void LoopbackBindingBehindADeclaredProxyWithNoTokenThrows(string address)
  {
    var exception = Assert.Throws<InvalidOperationException>(() => StartupBindingGuard.Validate(
      [address],
      dashboardToken: null,
      trustedProxies: ["127.0.0.1"],
      allowLoopbackOperatorWithoutToken: true));

    Assert.Contains(StartupBindingGuard.DashboardTokenConfigKey, exception.Message, StringComparison.Ordinal);
    Assert.Contains(TrustedProxies.ConfigKey, exception.Message, StringComparison.Ordinal);
  }

  /// <summary>
  /// The shipped default — nothing configured at all — must FAIL CLOSED. Before the opt-in
  /// existed, this exact configuration started happily on a loopback binding and then handed the
  /// operator role to every loopback peer, which behind a same-host proxy is the whole internet.
  /// </summary>
  [Theory]
  [InlineData("http://localhost:5000")]
  [InlineData("http://127.0.0.1:5000")]
  [InlineData("http://[::1]:5000")]
  public void LoopbackBindingWithNoTokenAndNoOptInThrows(string address)
  {
    var exception = Assert.Throws<InvalidOperationException>(() => StartupBindingGuard.Validate(
      [address],
      dashboardToken: null,
      trustedProxies: [],
      allowLoopbackOperatorWithoutToken: false));

    Assert.Contains(StartupBindingGuard.DashboardTokenConfigKey, exception.Message, StringComparison.Ordinal);
    Assert.Contains(
      StartupBindingGuard.AllowLoopbackOperatorWithoutTokenConfigKey,
      exception.Message,
      StringComparison.Ordinal);
  }

  /// <summary>No bindings reported at all is still not an excuse to skip the opt-in check.</summary>
  [Fact]
  public void NoBindingsWithNoTokenAndNoOptInThrows() =>
    Assert.Throws<InvalidOperationException>(() => StartupBindingGuard.Validate(
      [],
      dashboardToken: null,
      trustedProxies: [],
      allowLoopbackOperatorWithoutToken: false));
}
