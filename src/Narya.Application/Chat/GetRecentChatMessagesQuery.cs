using MediatR;

using Narya.Core.Chat;

namespace Narya.Application.Chat;

/// <summary>A port of legacy's <c>GET /api/chat/recent</c> — see <see cref="IChatStore.GetRecentMessagesAsync"/>.</summary>
public sealed record GetRecentChatMessagesQuery : IRequest<IReadOnlyList<ChatMessage>>;

public sealed class GetRecentChatMessagesQueryHandler(IChatStore store)
  : IRequestHandler<GetRecentChatMessagesQuery, IReadOnlyList<ChatMessage>>
{
  /// <summary>Matches legacy's <c>limit 40</c> in <c>legacy/src/server/routes.ts</c>.</summary>
  private const int Limit = 40;

  public Task<IReadOnlyList<ChatMessage>> Handle(GetRecentChatMessagesQuery request, CancellationToken cancellationToken) =>
    store.GetRecentMessagesAsync(Limit, cancellationToken);
}
