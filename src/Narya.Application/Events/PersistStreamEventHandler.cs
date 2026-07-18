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
/// after its <c>insert or ignore</c>. This is a deliberate simplification, not a claim that every
/// <see cref="StreamEvent.Id"/> is unique per delivery: most ids <c>EventSubDispatcher</c> mints
/// are a fresh <see cref="Guid"/> per call, but a channel-points redemption's id is deliberately
/// the raw Twitch redemption id — STABLE across a redelivery, because that stability is exactly
/// what dedup needs to key off. A genuine redelivered redemption therefore COULD double-broadcast
/// here (the operator's live feed shows the same event twice); what actually matters — a
/// redelivered redeem never firing its Action twice — is enforced downstream by Phase 4's
/// <c>automation_runs</c> dedup, which keys off this same stable redemption id. Skipping THIS
/// broadcast on redelivery would only add complexity without closing a real failure mode, since
/// the load-bearing dedup already lives where the side effect (playing media, running an Action)
/// actually happens.
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
