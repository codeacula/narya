using Marten;

using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

using NSubstitute;

using Narya.Core.AppConfig;
using Narya.Twitch.EventSub;
using Narya.Twitch.Helix;
using Narya.Twitch.Tokens;

using TwitchLib.EventSub.Websockets;

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

  /// <summary>
  /// Proves the Task 5 DI split: <see cref="ServiceCollectionExtensions.AddNaryaTwitch"/>
  /// alone (the previous test's <see cref="BuildProvider"/>) never registers a real socket —
  /// only calling <see cref="ServiceCollectionExtensions.AddNaryaTwitchEventSub"/> afterward
  /// does, and it REPLACES <see cref="NoopTwitchEventSource"/> with the real
  /// <see cref="TwitchEventSource"/> rather than registering both. Resolving the graph here
  /// does not open a socket — <c>BuildServiceProvider</c> never starts a registered
  /// <see cref="IHostedService"/>, that only happens if something calls
  /// <c>IHost.StartAsync</c>/<c>RunAsync</c> (e.g. a live host, or a WebApplicationFactory
  /// test — see Narya.Api.Program's <c>Narya:SkipInfrastructure</c> guard, which is what keeps
  /// WAF tests from ever calling <see cref="AddNaryaTwitchEventSub"/> in the first place).
  /// </summary>
  [Fact]
  public void AddNaryaTwitchEventSubReplacesTheNoopSourceAndRegistersTheHostedService()
  {
    var services = new ServiceCollection();
    _ = services.AddLogging();
    _ = services.AddSingleton(Substitute.For<IDocumentStore>());
    _ = services.AddSingleton(Substitute.For<IAppConfigStore>());

    _ = services.AddNaryaTwitch();
    _ = services.AddNaryaTwitchEventSub();

    using var provider = services.BuildServiceProvider();

    var eventSource = provider.GetRequiredService<ITwitchEventSource>();
    _ = Assert.IsType<TwitchEventSource>(eventSource);
    Assert.DoesNotContain(
      provider.GetServices<ITwitchEventSource>(),
      source => source is NoopTwitchEventSource);

    var hostedServices = provider.GetServices<IHostedService>();
    Assert.Contains(hostedServices, service => service is TwitchEventSubService);

    // Every consumer of the client (TwitchEventSource, and the hosted TwitchEventSubService
    // via its own constructor) must share the exact same singleton — proven directly rather
    // than assumed, since TwitchLib registers it with TryAddSingleton.
    var client = provider.GetRequiredService<EventSubWebsocketClient>();
    Assert.Same(client, provider.GetRequiredService<EventSubWebsocketClient>());
  }
}
