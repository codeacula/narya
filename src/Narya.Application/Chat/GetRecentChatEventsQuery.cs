using MediatR;

using Narya.Core.Chat;

namespace Narya.Application.Chat;

/// <summary>A port of legacy's <c>GET /api/chat/events/recent</c> — see <see cref="IChatStore.GetRecentEventsAsync"/>.</summary>
public sealed record GetRecentChatEventsQuery : IRequest<IReadOnlyList<ChatEvent>>;

public sealed class GetRecentChatEventsQueryHandler(IChatStore store)
  : IRequestHandler<GetRecentChatEventsQuery, IReadOnlyList<ChatEvent>>
{
  /// <summary>Matches legacy's <c>limit 100</c> in <c>legacy/src/server/routes.ts</c>.</summary>
  private const int Limit = 100;

  public Task<IReadOnlyList<ChatEvent>> Handle(GetRecentChatEventsQuery request, CancellationToken cancellationToken) =>
    store.GetRecentEventsAsync(Limit, cancellationToken);
}
