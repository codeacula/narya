using Marten;

using Microsoft.Extensions.DependencyInjection;

using Narya.Core.AppConfig;
using Narya.Core.Sessions;
using Narya.Database.AppConfig;
using Narya.Database.Sessions;

namespace Narya.Database;

public static class ServiceCollectionExtensions
{
  public static IServiceCollection AddNaryaDatabase(this IServiceCollection services, string connectionString)
  {
    _ = services
      .AddMarten(options =>
      {
        options.Connection(connectionString);
        NaryaMartenConfig.Configure(options);
      })
      .UseLightweightSessions();

    _ = services.AddSingleton<IAppConfigStore, AppConfigStore>();
    _ = services.AddSingleton<IStreamSessionStore, StreamSessionStore>();

    return services;
  }
}
