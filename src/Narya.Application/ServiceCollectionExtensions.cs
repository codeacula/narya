using FluentValidation;

using Microsoft.Extensions.DependencyInjection;

using Narya.Application.Behaviors;

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
    return services;
  }
}
