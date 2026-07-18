using MediatR;

using Narya.Core.Events;

namespace Narya.Application.Events;

/// <summary>A port of legacy's <c>GET /api/dashboard/events</c> — see <see cref="IStreamEventStore.GetRecentAsync"/>.</summary>
public sealed record GetRecentStreamEventsQuery : IRequest<IReadOnlyList<StreamEvent>>;

public sealed class GetRecentStreamEventsQueryHandler(IStreamEventStore store, TimeProvider timeProvider)
  : IRequestHandler<GetRecentStreamEventsQuery, IReadOnlyList<StreamEvent>>
{
  /// <summary>Matches legacy's <c>limit 50</c> in <c>legacy/src/server/dashboard/status.ts</c>.</summary>
  private const int Limit = 50;

  public async Task<IReadOnlyList<StreamEvent>> Handle(GetRecentStreamEventsQuery request, CancellationToken cancellationToken)
  {
    var events = await store.GetRecentAsync(Limit, cancellationToken).ConfigureAwait(false);
    var now = timeProvider.GetUtcNow();

    return [.. events.Select(e => e with { Ago = RelativeTime.FormatAgo(e.ReceivedAt, now) })];
  }
}
