using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;

using Narya.Api.Auth;

namespace Narya.Api.Tests.Auth;

/// <summary>
/// Composition-root coverage for <see cref="StartupBindingGuardFilter"/>'s registration in
/// <c>Program.cs</c>, which CLAUDE.md calls out as needing its own test rather than being inferred
/// from end-to-end behavior.
///
/// <para>
/// Every other WebApplicationFactory host in this assembly sets <c>Narya:SkipInfrastructure=true</c>
/// — which is exactly the branch that SKIPS the registration — so without this test the wiring was
/// covered only by a manual runtime run. Deleting the <c>AddSingleton&lt;IStartupFilter,
/// StartupBindingGuardFilter&gt;()</c> line, inverting its condition, or reordering registrations
/// so it is dropped would leave <c>dotnet build</c> at 0/0 and every test green, while every
/// production deployment silently lost the startup guard and a non-loopback bind with no token
/// started and served again.
/// </para>
///
/// <para>
/// The host is therefore built WITHOUT <c>SkipInfrastructure</c>, and does not need a live
/// Postgres/Redis: every infrastructure registration on that branch is lazy (<c>AddNaryaCache</c>
/// hands <see cref="Microsoft.Extensions.DependencyInjection.ServiceCollectionServiceExtensions"/>
/// a factory delegate, Marten and the hosted services are registration-only), and
/// <see cref="CaptureServices"/> aborts the build with <see cref="AbortBuildException"/> from the
/// last <c>ConfigureServices</c> callback. Nothing after <c>builder.Build()</c> in
/// <c>Program.cs</c> runs — no <c>BuiltInSlashCommandSeeder</c> against Postgres, no hosted
/// service start, no Twitch socket — and the service collection is inspected as the composition
/// root actually assembled it.
/// </para>
/// </summary>
public sealed class StartupBindingGuardCompositionTests
{
  private sealed class AbortBuildException : Exception;

  /// <summary>
  /// Builds the real composition root under the supplied settings and returns the assembled
  /// <see cref="IServiceCollection"/>, aborting before the host is ever started.
  /// </summary>
  private static IServiceCollection CaptureServices(params (string Key, string Value)[] settings)
  {
    IServiceCollection? captured = null;

    using var factory = new WebApplicationFactory<Program>()
      .WithWebHostBuilder(builder =>
      {
        // Placeholders only. Program.cs reads these strings and hands them to AddNaryaDatabase/
        // AddNaryaCache, which never dial anything at registration time — and the build is
        // aborted below before anything could resolve them.
        _ = builder.UseSetting("ConnectionStrings:Narya", "Host=localhost;Database=narya-composition-test");
        _ = builder.UseSetting("ConnectionStrings:Redis", "localhost:6379");

        foreach (var (key, value) in settings)
        {
          _ = builder.UseSetting(key, value);
        }

        _ = builder.ConfigureServices(services =>
        {
          captured = services;
          throw new AbortBuildException();
        });
      });

    _ = Assert.ThrowsAny<Exception>(() => factory.Services);

    Assert.NotNull(captured);
    return captured;
  }

  [Fact]
  public void CompositionRootRegistersTheStartupBindingGuardFilter()
  {
    var services = CaptureServices();

    Assert.Contains(
      services,
      descriptor => descriptor.ServiceType == typeof(IStartupFilter)
        && descriptor.ImplementationType == typeof(StartupBindingGuardFilter));
  }

  /// <summary>
  /// The negative control. Without it the assertion above could pass against a Program.cs that
  /// registered the filter unconditionally — which would break every SkipInfrastructure test host
  /// in this assembly — so pinning both sides of the condition is what makes the positive test
  /// meaningful.
  /// </summary>
  [Fact]
  public void SkipInfrastructureHostsDoNotRegisterTheStartupBindingGuardFilter()
  {
    var services = CaptureServices(("Narya:SkipInfrastructure", "true"));

    Assert.DoesNotContain(
      services,
      descriptor => descriptor.ServiceType == typeof(IStartupFilter)
        && descriptor.ImplementationType == typeof(StartupBindingGuardFilter));
  }
}
