using MediatR;

using Narya.Application.Events;
using Narya.Core.Viewers;

namespace Narya.Application.Viewers;

/// <summary>A port of legacy's <c>GET /api/dashboard/viewers</c> — see <see cref="IViewerStore.GetRecentViewersAsync"/>.</summary>
public sealed record GetRecentViewersQuery : IRequest<IReadOnlyDictionary<string, Viewer>>;

/// <summary>
/// Stamps <see cref="ViewerRecentMessage.Ago"/> from the raw <see cref="ViewerRecentMessage.ReceivedAt"/>
/// the store returns — <see cref="IViewerStore.GetRecentViewersAsync"/> never touches a clock, the
/// same raw-then-enriched split <see cref="GetRecentStreamEventsQueryHandler"/> uses for
/// <c>StreamEvent.Ago</c>. Reuses <see cref="RelativeTime.FormatAgo"/> directly (both live in
/// Narya.Application) rather than duplicating the formatting logic.
/// </summary>
public sealed class GetRecentViewersQueryHandler(IViewerStore store, TimeProvider timeProvider)
  : IRequestHandler<GetRecentViewersQuery, IReadOnlyDictionary<string, Viewer>>
{
  /// <summary>Matches legacy's <c>DASHBOARD_RECENT_VIEWER_MESSAGE_LIMIT</c> in <c>legacy/src/shared/constants.ts</c>.</summary>
  private const int MessageScanLimit = 500;

  public async Task<IReadOnlyDictionary<string, Viewer>> Handle(GetRecentViewersQuery request, CancellationToken cancellationToken)
  {
    var viewers = await store.GetRecentViewersAsync(MessageScanLimit, cancellationToken).ConfigureAwait(false);
    var now = timeProvider.GetUtcNow();

    return viewers.ToDictionary(
      kv => kv.Key,
      kv => kv.Value with
      {
        Recent = [.. kv.Value.Recent.Select(m => m with { Ago = RelativeTime.FormatAgo(m.ReceivedAt, now) })],
      },
      StringComparer.Ordinal);
  }
}
