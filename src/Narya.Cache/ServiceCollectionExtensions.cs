using Microsoft.Extensions.DependencyInjection;

using StackExchange.Redis;

using Narya.Core.Realtime;

namespace Narya.Cache;

public static class ServiceCollectionExtensions
{
  /// <summary>
  /// Registers a singleton <see cref="IConnectionMultiplexer"/> (one physical connection
  /// pool for the process's lifetime — StackExchange.Redis's own guidance) and the
  /// <see cref="IRealtimePublisher"/> built on top of it.
  /// </summary>
  public static IServiceCollection AddNaryaCache(this IServiceCollection services, string redisConnectionString)
  {
    _ = services.AddSingleton<IConnectionMultiplexer>(_ => ConnectionMultiplexer.Connect(redisConnectionString));
    _ = services.AddSingleton<IRealtimePublisher, RealtimePublisher>();

    return services;
  }
}
