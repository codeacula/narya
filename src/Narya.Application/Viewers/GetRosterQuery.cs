using MediatR;

using Narya.Core.Viewers;

namespace Narya.Application.Viewers;

/// <summary>A port of legacy's <c>GET /api/viewers/roster</c> — see <see cref="IViewerStore.GetRosterAsync"/>.</summary>
public sealed record GetRosterQuery : IRequest<IReadOnlyList<ViewerRosterEntry>>;

public sealed class GetRosterQueryHandler(IViewerStore store) : IRequestHandler<GetRosterQuery, IReadOnlyList<ViewerRosterEntry>>
{
  public Task<IReadOnlyList<ViewerRosterEntry>> Handle(GetRosterQuery request, CancellationToken cancellationToken) =>
    store.GetRosterAsync(cancellationToken);
}
