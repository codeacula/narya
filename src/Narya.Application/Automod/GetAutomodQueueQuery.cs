using MediatR;

using Narya.Core.Automod;

namespace Narya.Application.Automod;

/// <summary>A port of legacy's <c>GET /api/automod/queue</c> — see <see cref="IAutomodStore.GetQueueAsync"/>.</summary>
public sealed record GetAutomodQueueQuery : IRequest<AutomodQueue>;

/// <summary>
/// Sweeps expired holds FIRST, publishing an <see cref="AutomodResolvedBroadcastNotification"/>
/// for each one <see cref="IAutomodStore.SweepExpiredHoldsAsync"/> actually swept, THEN fetches
/// and returns the queue. <see cref="IAutomodStore"/> is deliberately mediator-free (see its doc
/// comment), so this handler — not the store — is where a hold the sweep silently expired
/// becomes a real-time <c>automod:resolved</c> event; without this, a second operator client
/// would keep showing a swept hold as pending until it happened to re-fetch the queue itself.
/// </summary>
public sealed class GetAutomodQueueQueryHandler(IAutomodStore store, IMediator mediator)
  : IRequestHandler<GetAutomodQueueQuery, AutomodQueue>
{
  public async Task<AutomodQueue> Handle(GetAutomodQueueQuery request, CancellationToken cancellationToken)
  {
    var swept = await store.SweepExpiredHoldsAsync(cancellationToken).ConfigureAwait(false);

    foreach (var hold in swept)
    {
      await mediator.Publish(new AutomodResolvedBroadcastNotification(hold), cancellationToken).ConfigureAwait(false);
    }

    return await store.GetQueueAsync(cancellationToken).ConfigureAwait(false);
  }
}
