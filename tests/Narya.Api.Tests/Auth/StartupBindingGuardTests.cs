using Narya.Api.Auth;

namespace Narya.Api.Tests.Auth;

/// <summary>
/// The startup half of the reverse-proxy bypass fix. <see cref="DashboardTokenMiddleware"/>'s
/// per-request loopback check cannot enforce "non-loopback deployments need a token" — behind a
/// same-host proxy every request has a loopback peer — so the rule lives here, and these tests
/// exercise the guard directly rather than through <c>WebApplicationFactory</c> (which never
/// reaches the post-start code in Program.cs).
/// </summary>
public sealed class StartupBindingGuardTests
{
  [Theory]
  [InlineData("http://0.0.0.0:5000")]
  [InlineData("http://192.168.1.20:5000")]
  [InlineData("https://narya.example.com")]
  [InlineData("http://[::]:5000")]
  [InlineData("http://*:5000")]
  public void NonLoopbackBindingWithNoTokenThrowsNamingTheBindingAndConfigKey(string address)
  {
    var exception = Assert.Throws<InvalidOperationException>(
      () => StartupBindingGuard.Validate([address], dashboardToken: null));

    Assert.Contains(StartupBindingGuard.DashboardTokenConfigKey, exception.Message, StringComparison.Ordinal);
    Assert.Contains(address, exception.Message, StringComparison.Ordinal);
  }

  [Fact]
  public void EmptyTokenIsTreatedTheSameAsNoToken()
  {
    var exception = Assert.Throws<InvalidOperationException>(
      () => StartupBindingGuard.Validate(["http://0.0.0.0:5000"], dashboardToken: string.Empty));

    Assert.Contains(StartupBindingGuard.DashboardTokenConfigKey, exception.Message, StringComparison.Ordinal);
  }

  [Fact]
  public void OneNonLoopbackBindingAmongLoopbackOnesStillThrows()
  {
    _ = Assert.Throws<InvalidOperationException>(() => StartupBindingGuard.Validate(
      ["http://localhost:5000", "http://127.0.0.1:5001", "http://10.0.0.4:5002"],
      dashboardToken: null));
  }

  [Theory]
  [InlineData("http://localhost:5000")]
  [InlineData("http://127.0.0.1:5000")]
  [InlineData("http://127.0.0.53:5000")]
  [InlineData("http://[::1]:5000")]
  public void LoopbackOnlyBindingWithNoTokenIsAllowed(string address) =>
    StartupBindingGuard.Validate([address], dashboardToken: null);

  [Fact]
  public void NoBindingsAtAllWithNoTokenIsAllowed() =>
    StartupBindingGuard.Validate([], dashboardToken: null);

  [Theory]
  [InlineData("http://0.0.0.0:5000")]
  [InlineData("https://narya.example.com")]
  [InlineData("http://localhost:5000")]
  public void AnyBindingIsAllowedOnceATokenIsConfigured(string address) =>
    StartupBindingGuard.Validate([address], dashboardToken: "op-token");

  /// <summary>
  /// An address the guard cannot parse must fail CLOSED, the same way a null
  /// <c>RemoteIpAddress</c> does in <see cref="DashboardTokenMiddleware"/> — "I could not prove
  /// this is loopback" is not "this is loopback".
  /// </summary>
  [Fact]
  public void UnparseableBindingWithNoTokenThrows() =>
    Assert.Throws<InvalidOperationException>(
      () => StartupBindingGuard.Validate(["not a url at all"], dashboardToken: null));
}
