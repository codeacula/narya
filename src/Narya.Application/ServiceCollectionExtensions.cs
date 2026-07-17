using FluentValidation;

using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

using Narya.Application.Behaviors;
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

    return services;
  }
}
