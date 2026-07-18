using Marten;

using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

using Narya.Core.Actions;
using Narya.Core.AppConfig;
using Narya.Core.Automod;
using Narya.Core.Chat;
using Narya.Core.Events;
using Narya.Core.Media;
using Narya.Core.Sessions;
using Narya.Core.Viewers;
using Narya.Database.Actions;
using Narya.Database.AppConfig;
using Narya.Database.Automod;
using Narya.Database.Chat;
using Narya.Database.Events;
using Narya.Database.Media;
using Narya.Database.Sessions;
using Narya.Database.Viewers;

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
    _ = services.AddSingleton<IChatStore, ChatStore>();
    _ = services.AddSingleton<IStreamEventStore, StreamEventStore>();
    _ = services.AddSingleton<IViewerStore, ViewerStore>();
    _ = services.AddSingleton<IAutomodStore, AutomodStore>();
    _ = services.AddSingleton<IMediaAssetStore, MediaAssetStore>();
    _ = services.AddSingleton<IMediaResolver, MediaResolver>();
    _ = services.AddSingleton<IActionStore, ActionStore>();

    // TryAddSingleton: AutomodStore depends on TimeProvider (SweepExpiredHoldsAsync/GetQueueAsync's
    // "now"). Narya.Application also TryAdds TimeProvider.System, but Narya.Database must not
    // rely on AddNaryaApplication having run first — a host that composes AddNaryaDatabase alone
    // still needs a working clock the first time it resolves the automod queue.
    services.TryAddSingleton(TimeProvider.System);

    return services;
  }
}
