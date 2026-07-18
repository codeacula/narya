using MediatR;

using Narya.Core.Chat;
using Narya.Core.Realtime;

namespace Narya.Twitch.EventSub.Notifications;

/// <summary>
/// Published for a moderation action affecting chat: a single message delete
/// (<c>channel.chat.message_delete</c>), a full clear (<c>channel.chat.clear</c>), or a
/// per-user bulk clear/ban/timeout (<c>channel.chat.clear_user_messages</c> — no reason text;
/// <c>channel.moderate</c> v2 would carry one but is deferred, see
/// <see cref="EventSubSubscriptions"/>'s doc comment at its former place in the subscription
/// table). Broadcasts as <c>chat:moderated</c>, allowlisted for overlays — the
/// overlay hides moderated messages entirely rather than showing the reason (legacy's
/// <c>compact</c> <c>ChatPanel</c> behavior).
///
/// <c>ChatMessageReceivedNotification</c> (the <c>chat:message</c> counterpart to this type)
/// moved to <c>Narya.Core.Chat.ChatMessageIngestedNotification</c> in Phase 3, split into an
/// ingested/broadcast pair — see that type's doc comment. This type is unaffected: Task 2 will
/// give moderation the same persistence-before-broadcast treatment, at which point this record
/// will likely move too.
/// </summary>
public sealed record ChatModeratedNotification(ChatModerationEvent ModerationEvent) : INotification, IRealtimeNotification
{
  public string EventName => "chat:moderated";

  public object Payload => ModerationEvent;
}
