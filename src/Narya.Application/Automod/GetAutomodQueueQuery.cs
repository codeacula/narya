using MediatR;

using Narya.Core.Automod;

namespace Narya.Application.Automod;

/// <summary>A port of legacy's <c>GET /api/automod/queue</c> — see <see cref="IAutomodStore.GetQueueAsync"/>.</summary>
public sealed record GetAutomodQueueQuery : IRequest<AutomodQueue>;

public sealed class GetAutomodQueueQueryHandler(IAutomodStore store) : IRequestHandler<GetAutomodQueueQuery, AutomodQueue>
{
  public Task<AutomodQueue> Handle(GetAutomodQueueQuery request, CancellationToken cancellationToken) =>
    store.GetQueueAsync(cancellationToken);
}
