using MediatR;

using Narya.Core.Realtime;
using Narya.Twitch.Chat;

namespace Narya.Twitch.EventSub.Notifications;

/// <summary>
/// Published whenever <see cref="EventSubDispatcher.DispatchChatMessage"/> returns non-null
/// (i.e. the message was not the bot's own — see that method's bot-loop guard). Broadcasts as
/// <c>chat:message</c>, allowlisted for overlays (<see cref="RealtimeEventNames.OverlayAllowlist"/>)
/// — the legacy chat overlay renders these directly.
/// </summary>
public sealed record ChatMessageReceivedNotification(ChatMessage Message) : INotification, IRealtimeNotification
{
  public string EventName => "chat:message";

  public object Payload => Message;
}

/// <summary>
/// Published for a moderation action affecting chat: a single message delete
/// (<c>channel.chat.message_delete</c>), a full clear (<c>channel.chat.clear</c>), or a
/// per-user bulk clear/ban/timeout (<c>channel.chat.clear_user_messages</c> — no reason text;
/// <c>channel.moderate</c> v2 would carry one but is deferred, see
/// <see cref="EventSubSubscriptions"/>'s doc comment at its former place in the subscription
/// table). Broadcasts as <c>chat:moderated</c>, allowlisted for overlays — the
/// overlay hides moderated messages entirely rather than showing the reason (legacy's
/// <c>compact</c> <c>ChatPanel</c> behavior).
/// </summary>
public sealed record ChatModeratedNotification(ChatModerationEvent ModerationEvent) : INotification, IRealtimeNotification
{
  public string EventName => "chat:moderated";

  public object Payload => ModerationEvent;
}
