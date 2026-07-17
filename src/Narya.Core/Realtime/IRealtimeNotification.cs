namespace Narya.Core.Realtime;

/// <summary>
/// A MediatR notification that should also be broadcast to connected clients over the
/// realtime channel. The application layer publishes these as ordinary MediatR
/// notifications; a handler in the composition root (Task 10) forwards
/// <see cref="EventName"/>/<see cref="Payload"/> to the WebSocket bridge instead of the
/// application layer taking a dependency on the transport itself.
/// </summary>
public interface IRealtimeNotification
{
  string EventName { get; }

  object Payload { get; }
}
