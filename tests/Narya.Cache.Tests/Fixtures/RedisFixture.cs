using StackExchange.Redis;

using Testcontainers.Redis;

namespace Narya.Cache.Tests.Fixtures;

/// <summary>
/// One Redis container shared across every test in <see cref="RealtimePublisherTests"/>
/// via <see cref="IClassFixture{TFixture}"/> — mirrors
/// <c>Narya.Database.Tests.Fixtures.PostgresFixture</c>'s shape for the same reason: spin
/// up the container once, not once per test method.
/// </summary>
public sealed class RedisFixture : IAsyncLifetime
{
  private readonly RedisContainer _container = new RedisBuilder("redis:alpine").Build();

  public IConnectionMultiplexer Multiplexer { get; private set; } = null!;

  public async Task InitializeAsync()
  {
    await _container.StartAsync();
    Multiplexer = await ConnectionMultiplexer.ConnectAsync(_container.GetConnectionString());
  }

  public async Task DisposeAsync()
  {
    await Multiplexer.DisposeAsync();
    await _container.DisposeAsync();
  }
}
