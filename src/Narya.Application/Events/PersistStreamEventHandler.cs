using MediatR;

using Narya.Core.Events;
using Narya.Core.Sessions;

namespace Narya.Application.Events;

/// <summary>
/// Persists every ingested stream event and stamps it with the active stream session before
/// broadcasting — a port of legacy's <c>eventsub.ts</c> <c>emitStreamEvent</c>.
///
/// <b>Broadcasts unconditionally, even on a redelivery.</b> Unlike
/// <c>Narya.Application.Chat.PersistChatMessageHandler</c>, which stops entirely on a redelivered
/// message id (no chatters bump, no broadcast), this handler always publishes
/// <see cref="StreamEventBroadcastNotification"/> after calling
/// <see cref="IStreamEventStore.InsertAsync"/> regardless of its return value — matching legacy's
/// <c>emitStreamEvent</c>, which called <c>broadcast('stream:event', ...)</c> unconditionally
/// after its <c>insert or ignore</c>. This is a deliberate simplification, not an oversight:
/// every <see cref="StreamEvent.Id"/> <c>EventSubDispatcher</c> mints is a fresh
/// <see cref="Guid"/> (or, for a redeem, the Twitch redemption id — still effectively unique per
/// delivery), so a genuine same-id redelivery isn't the real, load-bearing concern that a
/// redelivered chat message id is; skipping the broadcast on the rare theoretical duplicate would
/// only add complexity without a real failure mode to guard against.
/// </summary>
public sealed class PersistStreamEventHandler(
  IStreamEventStore eventStore, IStreamSessionStore sessionStore, IMediator mediator)
  : INotificationHandler<StreamEventIngestedNotification>
{
  public async Task Handle(StreamEventIngestedNotification notification, CancellationToken cancellationToken)
  {
    var sessionId = await sessionStore.GetCurrentSessionIdAsync(cancellationToken).ConfigureAwait(false);

    var enriched = notification.Event with
    {
      SessionId = sessionId,
      ActorLogin = NormalizeLogin(notification.Event.ActorLogin),
      Ago = "just now",
    };

    _ = await eventStore.InsertAsync(enriched, cancellationToken).ConfigureAwait(false);

    await mediator.Publish(new StreamEventBroadcastNotification(enriched), cancellationToken).ConfigureAwait(false);
  }

  /// <summary>Mirrors legacy's <c>actorLogin?.toLowerCase() || null</c> — an empty string normalizes to null, same as a missing login.</summary>
  private static string? NormalizeLogin(string? login) =>
    string.IsNullOrEmpty(login) ? null : login.ToLowerInvariant();
}
