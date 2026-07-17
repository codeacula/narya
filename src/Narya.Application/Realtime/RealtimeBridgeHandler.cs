using MediatR;

using Microsoft.Extensions.Logging;

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
public sealed partial class RealtimeBridgeHandler<T>(IRealtimePublisher publisher, ILogger<RealtimeBridgeHandler<T>> logger)
  : INotificationHandler<T>
  where T : IRealtimeNotification, INotification
{
  /// <summary>
  /// Deliberate, scoped exception to the no-blanket-catch rule: by the time this handler
  /// runs, the notification's originating command has already committed (see
  /// <c>UpdateAppConfigCommandHandler</c>, which publishes only after
  /// <c>store.UpdateAsync</c> succeeds), so realtime delivery here is best-effort BY
  /// DESIGN — a Redis outage must not turn an already-succeeded write into a 500 the
  /// operator is tempted to retry, which would duplicate the write. A transport failure
  /// is logged and swallowed; genuine cancellation still propagates.
  /// </summary>
  public async Task Handle(T notification, CancellationToken cancellationToken)
  {
    try
    {
      await publisher.PublishAsync(notification.EventName, notification.Payload, cancellationToken)
        .ConfigureAwait(false);
    }
    catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
    {
      throw;
    }
    catch (Exception ex)
    {
      LogPublishFailed(logger, notification.EventName, ex);
    }
  }

  [LoggerMessage(
    Level = LogLevel.Warning,
    Message = "Failed to publish realtime event {EventName}; the originating operation already committed")]
  private static partial void LogPublishFailed(ILogger logger, string eventName, Exception exception);
}
