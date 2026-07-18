using FluentValidation;

using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

using Narya.Application.Behaviors;
using Narya.Core.Dashboard;
using Narya.Core.Media;
using Narya.Core.Realtime;

namespace Narya.Application;

public static class ServiceCollectionExtensions
{
  public static IServiceCollection AddNaryaApplication(this IServiceCollection services)
  {
    _ = services.AddValidatorsFromAssemblyContaining<NaryaApplication>();
    _ = services.AddMediatR(cfg =>
    {
      _ = cfg.RegisterServicesFromAssemblyContaining<NaryaApplication>();
      _ = cfg.AddOpenBehavior(typeof(LoggingBehavior<,>));
      _ = cfg.AddOpenBehavior(typeof(ValidationBehavior<,>));
    });

    // NOT also registered explicitly here: MediatR's assembly scan
    // (RegisterServicesFromAssemblyContaining above) already discovers the open generic
    // RealtimeBridgeHandler<T> despite its extra IRealtimeNotification constraint —
    // confirmed empirically by RealtimeBridgeHandlerTests, which resolves
    // INotificationHandler<AppConfigUpdatedNotification> and asserts exactly one
    // instance. Adding a second, explicit AddTransient(typeof(INotificationHandler<>),
    // typeof(RealtimeBridgeHandler<>)) registration here would double that to two
    // handlers, and MediatR invokes every registered handler for a Publish — silently
    // double-publishing every realtime event to Redis.

    // TryAddSingleton, not AddSingleton: RealtimeBridgeHandler<T> hard-depends on
    // IRealtimePublisher, so any host that composes AddNaryaApplication without also
    // composing Narya.Cache's AddNaryaCache (a future Narya.Agent host; a WebApplicationFactory
    // test host under Narya:SkipInfrastructure) would otherwise crash the first time it
    // publishes a realtime notification. TryAdd is a no-op when AddNaryaCache already
    // registered the real RealtimePublisher (whether AddNaryaCache ran before or after this
    // call — see RealtimePublisherCompositionTests), so a host with both always resolves the
    // real publisher, never this default.
    services.TryAddSingleton<IRealtimePublisher, NullRealtimePublisher>();

    // TryAddSingleton: StreamOfflineHandler (Sessions) depends on TimeProvider. Narya.Twitch
    // also TryAdds TimeProvider.System (for TwitchCredentials) but Narya.Application must not
    // rely on Narya.Twitch's registration having run first — a host that composes
    // AddNaryaApplication without AddNaryaTwitch (a future Narya.Agent host; a
    // WebApplicationFactory test under Narya:SkipInfrastructure) still needs a working clock
    // the first time it publishes StreamOfflineNotification.
    services.TryAddSingleton(TimeProvider.System);

    // TryAddSingleton, same rationale as IRealtimePublisher above:
    // GetDashboardStatusQueryHandler hard-depends on IDashboardTwitchStatusProvider, so a host
    // that composes AddNaryaApplication without also composing Narya.Twitch's AddNaryaTwitch
    // (a WebApplicationFactory test under Narya:SkipInfrastructure) still needs something to
    // resolve. See NullDashboardTwitchStatusProvider's doc comment.
    services.TryAddSingleton<IDashboardTwitchStatusProvider, NullDashboardTwitchStatusProvider>();

    // TryAddSingleton, same rationale as IRealtimePublisher/IDashboardTwitchStatusProvider above:
    // Narya.Api.Controllers.MediaAssetsController hard-depends on IMediaFileCatalog (and, once
    // AddNaryaDatabase does run, so does Narya.Database.Media.MediaAssetStore), so a host that
    // composes AddNaryaApplication without also composing Narya.Database's AddNaryaDatabase — a
    // WebApplicationFactory test under Narya:SkipInfrastructure — still needs something to
    // resolve the controller's constructor. See NullMediaFileCatalog's doc comment for why Phase 4
    // ships only this default (Phase 5 owns the real filesystem/companion catalog, registered
    // with a plain AddSingleton that always wins over this TryAddSingleton).
    services.TryAddSingleton<IMediaFileCatalog, NullMediaFileCatalog>();

    return services;
  }
}
