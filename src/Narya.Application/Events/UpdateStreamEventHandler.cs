using MediatR;

using Narya.Core.Events;

namespace Narya.Application.Events;

/// <summary>
/// Applies the subscribe/subscription.message merge update to the stored row, THEN broadcasts —
/// a port of legacy's <c>eventsub.ts</c> <c>updateStreamEvent</c>, which always persisted before
/// broadcasting.
/// </summary>
public sealed class UpdateStreamEventHandler(IStreamEventStore eventStore, IMediator mediator)
  : INotificationHandler<StreamEventUpdateIngestedNotification>
{
  public async Task Handle(StreamEventUpdateIngestedNotification notification, CancellationToken cancellationToken)
  {
    var update = notification.Update;

    await eventStore.UpdateDetailToneAsync(update.Id, update.Detail, update.Tone, cancellationToken).ConfigureAwait(false);

    await mediator.Publish(new StreamEventUpdateBroadcastNotification(update), cancellationToken).ConfigureAwait(false);
  }
}
