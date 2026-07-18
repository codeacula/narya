using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;

namespace Narya.Api.Auth;

/// <summary>
/// Runs <see cref="StartupBindingGuard"/> at pipeline-build time, which is the whole point of
/// doing it from an <see cref="IStartupFilter"/> rather than after <c>app.StartAsync()</c>.
///
/// <para>
/// <c>GenericWebHostService.StartAsync</c> populates <see cref="IServerAddressesFeature"/> from
/// configuration (including <c>--urls</c> and <c>ASPNETCORE_URLS</c>) and builds the middleware
/// pipeline BEFORE calling <c>Server.StartAsync</c>. Reading the addresses here therefore sees
/// exactly what the post-start code saw, while the listening socket is still closed — so an
/// unsafe deployment never accepts a connection at all. Validating after start instead left a
/// window in which Kestrel was bound and <see cref="DashboardTokenMiddleware"/>'s no-token path
/// was live on the very address the guard exists to reject; requirement 1 of the task is "fail
/// fast at startup — not serve requests", and a request served during a start/stop cycle cannot
/// be un-served.
/// </para>
/// </summary>
public sealed class StartupBindingGuardFilter(IConfiguration configuration) : IStartupFilter
{
  public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next) => builder =>
  {
    // ServerFeatures is the same feature collection GenericWebHostService just populated. The
    // IServer fallback covers a host that builds the pipeline from a builder without it.
    var addresses = builder.ServerFeatures.Get<IServerAddressesFeature>()?.Addresses
      ?? builder.ApplicationServices.GetService<IServer>()?.Features.Get<IServerAddressesFeature>()?.Addresses
      ?? [];

    StartupBindingGuard.Validate(
      addresses,
      configuration[StartupBindingGuard.DashboardTokenConfigKey],
      TrustedProxies.Read(configuration),
      configuration.GetValue<bool>(StartupBindingGuard.AllowLoopbackOperatorWithoutTokenConfigKey));

    next(builder);
  };
}
