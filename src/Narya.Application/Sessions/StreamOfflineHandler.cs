using MediatR;

using Narya.Core.Sessions;

namespace Narya.Application.Sessions;

/// <summary>
/// Ends the active stream session on <c>stream.offline</c>. Twitch's <c>stream.offline</c>
/// payload carries no timestamp, so the end time is "now" per <see cref="TimeProvider"/>
/// (injected rather than <c>DateTimeOffset.UtcNow</c> directly, so tests can control it).
/// </summary>
public sealed class StreamOfflineHandler(IStreamSessionStore store, TimeProvider clock) : INotificationHandler<StreamOfflineNotification>
{
  public Task Handle(StreamOfflineNotification notification, CancellationToken cancellationToken) =>
    store.EndActiveSessionAsync(clock.GetUtcNow(), cancellationToken);
}
