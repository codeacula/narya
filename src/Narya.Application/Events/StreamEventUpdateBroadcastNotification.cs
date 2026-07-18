using MediatR;

using Narya.Core.Events;
using Narya.Core.Realtime;

namespace Narya.Application.Events;

/// <summary>
/// The "broadcast" half of Task 4's ingested→broadcast split for the sub-merge update — mirrors
/// <see cref="StreamEventBroadcastNotification"/>. Published by <see cref="UpdateStreamEventHandler"/>
/// only AFTER the stored <c>stream_events</c> row has been updated — see
/// <see cref="StreamEventUpdateIngestedNotification"/>'s doc comment for why persist-then-broadcast
/// ordering matters here. Implements <see cref="IRealtimeNotification"/> so
/// <see cref="Narya.Application.Realtime.RealtimeBridgeHandler{T}"/> forwards it under the
/// <c>stream:event:update</c> event name. Overlay-allowlisted — see
/// <see cref="RealtimeEventNames.OverlayAllowlist"/>.
/// </summary>
public sealed record StreamEventUpdateBroadcastNotification(StreamEventUpdate Update) : INotification, IRealtimeNotification
{
  public string EventName => "stream:event:update";

  public object Payload => Update;
}
