using Marten;

using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;

using NSubstitute;

using StackExchange.Redis;

using Narya.Core.AppConfig;
using Narya.Core.Automod;
using Narya.Core.Chat;
using Narya.Core.Events;
using Narya.Core.Sessions;
using Narya.Core.Viewers;

namespace Narya.Api.Tests;

/// <summary>
/// Locks in the fix for the review finding that <c>Narya:SkipInfrastructure</c> never
/// actually engaged in these WebApplicationFactory-hosted tests: Program.cs reads the flag
/// via <c>builder.Configuration.GetValue&lt;bool&gt;("Narya:SkipInfrastructure")</c> in
/// top-level code, which runs BEFORE WebApplicationFactory's
/// <c>ConfigureAppConfiguration</c>+<c>AddInMemoryCollection</c> values become visible — so
/// every WAF test in this assembly was silently exercising a live Postgres/Redis via
/// <c>AddNaryaDatabase</c>/<c>AddNaryaCache</c> regardless of the flag. The fix (see
/// <c>DashboardTokenMiddlewareTests.BuildClient</c> and
/// <c>ConfigControllerTests.BuildOperatorClient</c>) sets the flag with
/// <c>IWebHostBuilder.UseSetting</c> instead, which IS visible at that early read.
///
/// This test asserts the observable consequence directly: with the flag set, the host must
/// not register <see cref="IConnectionMultiplexer"/> or <see cref="IDocumentStore"/> at
/// all — proving SkipInfrastructure truly suppressed <c>AddNaryaDatabase</c>/
/// <c>AddNaryaCache</c> rather than merely running against infrastructure that happened to
/// be reachable.
/// </summary>
public sealed class InfrastructureSkipTests
{
  /// <summary>
  /// Under SkipInfrastructure, <c>AddNaryaDatabase</c> (the only source of
  /// <see cref="IAppConfigStore"/>/<see cref="IStreamSessionStore"/>/<see cref="IChatStore"/>/
  /// <see cref="IStreamEventStore"/>) never runs. Accessing <c>factory.Services</c> still builds
  /// the host, and ASP.NET's default Development-environment DI validation
  /// (<c>ValidateOnBuild</c>) eagerly constructs every registered handler, including the
  /// <c>/api/config</c> MediatR handlers that take a constructor dependency on
  /// <see cref="IAppConfigStore"/>, the Sessions
  /// <c>StreamOnlineHandler</c>/<c>StreamOfflineHandler</c> that depend on
  /// <see cref="IStreamSessionStore"/>, the chat <c>PersistChatMessageHandler</c>/
  /// <c>GetRecentChatMessagesQueryHandler</c>/<c>GetRecentChatEventsQueryHandler</c> that depend
  /// on <see cref="IChatStore"/>, the Events <c>PersistStreamEventHandler</c>/
  /// <c>UpdateStreamEventHandler</c>/<c>GetRecentStreamEventsQueryHandler</c> that depend on
  /// <see cref="IStreamEventStore"/>, the Viewers <c>UpdateViewerProfileCommandHandler</c>/
  /// <c>GetRosterQueryHandler</c>/<c>GetRecentViewersQueryHandler</c> that depend on
  /// <see cref="IViewerStore"/>, and the Automod <c>RecordAutomodHoldHandler</c>/
  /// <c>ResolveAutomodHoldHandler</c>/<c>GetAutomodQueueQueryHandler</c> that depend on
  /// <see cref="IAutomodStore"/> — unconfigured substitutes are enough to satisfy that.
  /// </summary>
  private static WebApplicationFactory<Program> BuildFactory() =>
    new WebApplicationFactory<Program>()
      .WithWebHostBuilder(b =>
      {
        _ = b.UseSetting("Narya:DashboardToken", "op-token");
        _ = b.UseSetting("Narya:SkipInfrastructure", "true");
        _ = b.ConfigureTestServices(services =>
        {
          _ = services.AddSingleton(Substitute.For<IAppConfigStore>());
          _ = services.AddSingleton(Substitute.For<IStreamSessionStore>());
          _ = services.AddSingleton(Substitute.For<IChatStore>());
          _ = services.AddSingleton(Substitute.For<IStreamEventStore>());
          _ = services.AddSingleton(Substitute.For<IViewerStore>());
          _ = services.AddSingleton(Substitute.For<IAutomodStore>());
        });
      });

  [Fact]
  public void SkipInfrastructureRegistersNoRedisConnectionMultiplexer()
  {
    using var factory = BuildFactory();

    Assert.Null(factory.Services.GetService<IConnectionMultiplexer>());
  }

  [Fact]
  public void SkipInfrastructureRegistersNoMartenDocumentStore()
  {
    using var factory = BuildFactory();

    Assert.Null(factory.Services.GetService<IDocumentStore>());
  }
}
