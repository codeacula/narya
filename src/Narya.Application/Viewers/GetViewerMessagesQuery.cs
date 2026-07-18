using MediatR;

using Narya.Core.Chat;

namespace Narya.Application.Viewers;

/// <summary>
/// A port of legacy's <c>GET /api/viewers/:login/messages</c> — keyset pagination scoped to one
/// viewer. See <see cref="IChatStore.GetMessagesByUsernameAsync"/>.
/// </summary>
public sealed record GetViewerMessagesQuery(string Login, string? Before) : IRequest<IReadOnlyList<ChatMessage>>;

public sealed class GetViewerMessagesQueryHandler(IChatStore store)
  : IRequestHandler<GetViewerMessagesQuery, IReadOnlyList<ChatMessage>>
{
  /// <summary>Matches legacy's <c>limit 80</c> in <c>legacy/src/server/dashboard/status.ts</c>.</summary>
  private const int PageSize = 80;

  public Task<IReadOnlyList<ChatMessage>> Handle(GetViewerMessagesQuery request, CancellationToken cancellationToken) =>
    store.GetMessagesByUsernameAsync(request.Login.Trim().ToLowerInvariant(), request.Before, PageSize, cancellationToken);
}
