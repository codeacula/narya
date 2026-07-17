using Marten;

using Microsoft.Extensions.DependencyInjection;

using Narya.Core.AppConfig;
using Narya.Database.AppConfig;

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

    return services;
  }
}
