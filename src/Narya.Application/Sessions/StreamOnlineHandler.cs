using MediatR;

using Narya.Core.Sessions;

namespace Narya.Application.Sessions;

/// <summary>
/// Starts (or resumes, if already started — see <see cref="IStreamSessionStore.GetOrStartSessionAsync"/>'s
/// idempotency) a stream session on <c>stream.online</c>. Keyed <c>"twitch:{streamId}"</c> —
/// the only source Phase 3 produces.
///
/// <para>
/// Legacy starts the session from inside the go-live Discord announce task; here it starts
/// directly from the online notification instead, so session tracking does not depend on
/// Phase 8's announce flow existing yet. Phase 8's announce flow will attach Discord ids to
/// the session this handler already created rather than creating it itself.
/// </para>
/// </summary>
public sealed class StreamOnlineHandler(IStreamSessionStore store) : INotificationHandler<StreamOnlineNotification>
{
  public Task Handle(StreamOnlineNotification notification, CancellationToken cancellationToken) =>
    store.GetOrStartSessionAsync($"twitch:{notification.StreamId}", notification.StartedAt, cancellationToken);
}
