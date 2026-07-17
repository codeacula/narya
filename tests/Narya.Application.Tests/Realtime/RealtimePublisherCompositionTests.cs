using Microsoft.Extensions.DependencyInjection;

using NSubstitute;

using StackExchange.Redis;

using Narya.Cache;
using Narya.Core.Realtime;

namespace Narya.Application.Tests.Realtime;

/// <summary>
/// Proves the fix for the review finding that a host calling <c>AddNaryaApplication()</c>
/// WITHOUT also calling <c>AddNaryaCache()</c> (the future <c>Narya.Agent</c> host is the
/// motivating case; a WebApplicationFactory test host under
/// <c>Narya:SkipInfrastructure</c> is another) would crash the first time
/// <c>RealtimeBridgeHandler&lt;T&gt;</c> tried to resolve its <see cref="IRealtimePublisher"/>
/// constructor dependency, since nothing registered one.
/// </summary>
public sealed class RealtimePublisherCompositionTests
{
  [Fact]
  public async Task ApplicationAloneResolvesNullPublisherAndDoesNotThrowOnPublish()
  {
    var services = new ServiceCollection();
    _ = services.AddLogging();
    _ = services.AddNaryaApplication();

    await using var provider = services.BuildServiceProvider();
    var publisher = provider.GetRequiredService<IRealtimePublisher>();

    _ = Assert.IsType<NullRealtimePublisher>(publisher);
    var exception = await Record.ExceptionAsync(
      () => publisher.PublishAsync("some:event", new { }, CancellationToken.None));
    Assert.Null(exception);
  }

  [Fact]
  public void ApplicationThenCacheResolvesTheRealRealtimePublisher()
  {
    var services = new ServiceCollection();
    _ = services.AddLogging();
    _ = services.AddNaryaApplication();
    _ = services.AddNaryaCache("localhost:6379");

    // Overrides the IConnectionMultiplexer that AddNaryaCache wired up to a real
    // ConnectionMultiplexer.Connect factory — this test proves DI RESOLVES the real
    // RealtimePublisher type, not that it can reach a live Redis, so the substitute keeps
    // the assertion independent of any running infrastructure. AddSingleton (not TryAdd)
    // here is deliberate: the last IConnectionMultiplexer registration wins on resolve,
    // exactly like the IRealtimePublisher registration this test is actually about.
    _ = services.AddSingleton(Substitute.For<IConnectionMultiplexer>());

    using var provider = services.BuildServiceProvider();
    var publisher = provider.GetRequiredService<IRealtimePublisher>();

    _ = Assert.IsType<RealtimePublisher>(publisher);
  }

  [Fact]
  public void CacheThenApplicationStillResolvesTheRealRealtimePublisher()
  {
    // Same assertion as above with AddNaryaCache called FIRST — TryAddSingleton in
    // AddNaryaApplication must see the existing registration and no-op rather than
    // fight it, regardless of call order.
    var services = new ServiceCollection();
    _ = services.AddLogging();
    _ = services.AddNaryaCache("localhost:6379");
    _ = services.AddSingleton(Substitute.For<IConnectionMultiplexer>());
    _ = services.AddNaryaApplication();

    using var provider = services.BuildServiceProvider();
    var publisher = provider.GetRequiredService<IRealtimePublisher>();

    _ = Assert.IsType<RealtimePublisher>(publisher);
  }
}
