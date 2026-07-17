using MediatR;

using Narya.Core.Realtime;

namespace Narya.Application.Realtime;

/// <summary>
/// The entire realtime bridge: one generic handler for every notification that opts in by
/// implementing <see cref="IRealtimeNotification"/>, forwarding it to
/// <see cref="IRealtimePublisher"/>. Replaces the legacy pattern of one hand-written
/// broadcast call per event type — a new realtime event only needs its notification to
/// implement <see cref="IRealtimeNotification"/>; nothing here changes.
///
/// NOT explicitly registered in <c>AddNaryaApplication</c>: MediatR's
/// <c>RegisterServicesFromAssemblyContaining&lt;NaryaApplication&gt;</c> assembly scan
/// already discovers this open generic despite its extra <see cref="IRealtimeNotification"/>
/// constraint (confirmed empirically by <c>RealtimeBridgeHandlerTests</c>, which resolves
/// <c>INotificationHandler&lt;AppConfigUpdatedNotification&gt;</c> and asserts exactly one
/// instance). Adding a second, explicit registration would resolve two handler instances
/// per notification and MediatR invokes every one of them on <c>Publish</c> — silently
/// double-publishing every realtime event to Redis.
/// </summary>
public sealed class RealtimeBridgeHandler<T>(IRealtimePublisher publisher) : INotificationHandler<T>
  where T : IRealtimeNotification, INotification
{
  public Task Handle(T notification, CancellationToken cancellationToken) =>
    publisher.PublishAsync(notification.EventName, notification.Payload, cancellationToken);
}
