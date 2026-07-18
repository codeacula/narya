using MediatR;

using Narya.Core.Chat;
using Narya.Core.Realtime;

namespace Narya.Application.Chat;

/// <summary>
/// The "broadcast" half of Phase 3's ingested→broadcast split (see
/// <see cref="ChatMessageIngestedNotification"/>'s doc comment). Published by
/// <see cref="PersistChatMessageHandler"/> only after it has persisted the message and computed
/// <see cref="ChatMessage.IsFirstEver"/>/<see cref="ChatMessage.IsFirstThisSession"/>/
/// <see cref="ChatMessage.SessionId"/> — <see cref="Message"/> here is always the enriched copy,
/// never the raw ingested one. Implements <see cref="IRealtimeNotification"/> so
/// <see cref="Narya.Application.Realtime.RealtimeBridgeHandler{T}"/> (registered as an open
/// generic — no extra wiring needed here) forwards it to <see cref="IRealtimePublisher"/> under
/// the same <c>chat:message</c> event name Phase 2's <c>ChatMessageReceivedNotification</c> used
/// to broadcast directly.
/// </summary>
public sealed record ChatMessageBroadcastNotification(ChatMessage Message) : INotification, IRealtimeNotification
{
  public string EventName => "chat:message";

  public object Payload => Message;
}
