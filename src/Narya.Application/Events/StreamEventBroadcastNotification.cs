using MediatR;

using Narya.Core.Events;
using Narya.Core.Realtime;

namespace Narya.Application.Events;

/// <summary>
/// The "broadcast" half of Task 4's ingested→broadcast split (see
/// <see cref="StreamEventIngestedNotification"/>'s doc comment). Published by
/// <see cref="PersistStreamEventHandler"/> only after it has persisted the event and stamped
/// <see cref="StreamEvent.SessionId"/> — <see cref="Event"/> here is always the enriched copy,
/// never the raw ingested one. Implements <see cref="IRealtimeNotification"/> so
/// <see cref="Narya.Application.Realtime.RealtimeBridgeHandler{T}"/> (registered as an open
/// generic — no extra wiring needed here) forwards it to <see cref="IRealtimePublisher"/> under
/// the same <c>stream:event</c> event name Phase 2's <c>StreamEventOccurredNotification</c> used
/// to broadcast directly. Overlay-allowlisted (the shoutout ticker) — see
/// <see cref="RealtimeEventNames.OverlayAllowlist"/>.
/// </summary>
public sealed record StreamEventBroadcastNotification(StreamEvent Event) : INotification, IRealtimeNotification
{
  public string EventName => "stream:event";

  public object Payload => Event;
}
