using Marten;

using Microsoft.Extensions.DependencyInjection;

using NSubstitute;

using Narya.Core.AppConfig;
using Narya.Twitch.Helix;
using Narya.Twitch.Tokens;

namespace Narya.Twitch.Tests;

/// <summary>
/// Proves the Task 4 DI wiring in <see cref="ServiceCollectionExtensions.AddNaryaTwitch"/>
/// actually resolves — the gap Task 2 left open (<c>TwitchCredentials</c> needs
/// <see cref="IBroadcasterIdResolver"/>; <see cref="HelixClient"/> needs
/// <see cref="ITwitchCredentials"/>) is a genuine constructor-parameter cycle that
/// <see cref="BroadcasterIdResolverAdapter"/> breaks by resolving <see cref="IHelixClient"/>
/// lazily (on first call) instead of at construction time. A regression back to registering
/// <c>IBroadcasterIdResolver → HelixClient</c> directly does not fail fast — Microsoft.Extensions.DependencyInjection's
/// per-singleton construction lock is re-entrant on the constructing thread, so the cycle
/// silently recurses instead of throwing — so this test resolves on a background thread under
/// an explicit timeout rather than trusting a bare assert to ever return.
/// </summary>
public sealed class ServiceCollectionExtensionsTests
{
  private static ServiceProvider BuildProvider()
  {
    var services = new ServiceCollection();
    _ = services.AddLogging();

    // Everything AddNaryaTwitch needs that normally comes from Narya.Database/Narya.Api's own
    // composition root — substituted here so this test exercises only the Task 4 DI shape, not
    // a live Postgres connection.
    _ = services.AddSingleton(Substitute.For<IDocumentStore>());
    _ = services.AddSingleton(Substitute.For<IAppConfigStore>());

    _ = services.AddNaryaTwitch();

    return services.BuildServiceProvider();
  }

  [Fact]
  public async Task HelixClientAndBroadcasterIdResolverResolveToTheSameSingletonWithoutDeadlocking()
  {
    await using var provider = BuildProvider();

    var resolveTask = Task.Run(() => (
      HelixClient: provider.GetRequiredService<HelixClient>(),
      ViaInterface: provider.GetRequiredService<IHelixClient>(),
      Resolver: provider.GetRequiredService<IBroadcasterIdResolver>()));

    var winner = await Task.WhenAny(resolveTask, Task.Delay(TimeSpan.FromSeconds(10)));
    Assert.True(
      ReferenceEquals(winner, resolveTask),
      "Resolving IHelixClient/IBroadcasterIdResolver hung — the TwitchCredentials <-> HelixClient DI cycle regressed.");

    var resolved = await resolveTask;
    Assert.Same(resolved.HelixClient, resolved.ViaInterface);
    Assert.NotNull(resolved.Resolver);
    _ = Assert.IsType<BroadcasterIdResolverAdapter>(resolved.Resolver);
  }
}
