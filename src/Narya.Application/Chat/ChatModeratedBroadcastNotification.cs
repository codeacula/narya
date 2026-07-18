using MediatR;

using Narya.Core.Chat;
using Narya.Core.Realtime;

namespace Narya.Application.Chat;

/// <summary>
/// The "broadcast" half of Task 2's ingested→broadcast split for chat moderation — mirrors
/// <see cref="ChatMessageBroadcastNotification"/>. Published by
/// <see cref="PersistChatModerationHandler"/> only after the soft-delete has been persisted, so
/// <see cref="ModerationEvent"/> here always carries the FINAL values: <c>DeletedAt</c> is the
/// persisted <c>chat_events</c> row's <c>OccurredAt</c> (not whatever timestamp the raw
/// <see cref="ChatModeratedNotification"/> happened to carry), and <c>DeletedReason</c> is the
/// handler-resolved reason text. Implements
/// <see cref="IRealtimeNotification"/> so <see cref="Narya.Application.Realtime.RealtimeBridgeHandler{T}"/>
/// (registered as an open generic — no extra wiring needed here) forwards it to
/// <see cref="IRealtimePublisher"/> under the <c>chat:moderated</c> event name legacy's
/// <c>broadcast('chat:moderated', ...)</c> used, always AFTER the soft-delete write completes —
/// see <c>ChatModeratedNotification</c>'s doc comment for why persist-then-broadcast ordering
/// matters here.
/// </summary>
public sealed record ChatModeratedBroadcastNotification(ChatModerationEvent ModerationEvent) : INotification, IRealtimeNotification
{
  public string EventName => "chat:moderated";

  public object Payload => ModerationEvent;
}
