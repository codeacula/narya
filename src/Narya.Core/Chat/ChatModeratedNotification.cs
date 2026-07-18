using MediatR;

namespace Narya.Core.Chat;

/// <summary>
/// Published for a moderation action affecting chat: a single message delete
/// (<c>channel.chat.message_delete</c>), a full clear (<c>channel.chat.clear</c>), or a
/// per-user bulk clear/ban/timeout (<c>channel.chat.clear_user_messages</c> — no reason text;
/// <c>channel.moderate</c> v2 would carry one but is deferred, see
/// <c>Narya.Twitch.EventSub.EventSubSubscriptions</c>'s doc comment at its former place in the
/// subscription table).
///
/// Deliberately a plain <see cref="INotification"/>, NOT an
/// <c>Narya.Core.Realtime.IRealtimeNotification</c> — this is the "ingested" half of Task 2's
/// ingested→broadcast split, the same restructure <see cref="ChatMessage"/>'s
/// <see cref="ChatMessageIngestedNotification"/> counterpart went through in Task 1 (see that
/// type's doc comment). Broadcasting the raw <see cref="ModerationEvent"/> the instant it arrives
/// would let a client observe "message deleted" before the soft-delete (and its
/// <c>chat_events</c>-linked <c>ModerationEventId</c>) is actually persisted — legacy always
/// persisted first, then broadcast (<c>legacy/src/server/chat.ts</c>'s <c>messagedeleted</c>/
/// <c>timeout</c>/<c>ban</c>/<c>clearchat</c> handlers all call the <c>mark*Deleted</c> statement
/// before <c>broadcast('chat:moderated', ...)</c>). <c>Narya.Application.Chat.PersistChatModerationHandler</c>
/// is this notification's only consumer; once it has applied the soft-delete, it republishes the
/// final (persisted-timestamp, resolved-reason) copy as
/// <c>Narya.Application.Chat.ChatModeratedBroadcastNotification</c> (event name
/// <c>chat:moderated</c>), which the Phase 1 realtime bridge
/// (<c>Narya.Application.Realtime.RealtimeBridgeHandler&lt;T&gt;</c>) broadcasts — allowlisted
/// for overlays (the overlay hides moderated messages entirely rather than showing the reason,
/// legacy's <c>compact</c> <c>ChatPanel</c> behavior).
///
/// Originally defined in <c>Narya.Twitch.EventSub.Notifications</c> as
/// <c>ChatModeratedNotification : INotification, IRealtimeNotification</c> (Phase 2, direct
/// broadcast); moved here and stripped of <c>IRealtimeNotification</c> in Task 2 for the same
/// reference-direction reason <see cref="ChatMessage"/>/<see cref="ChatMessageIngestedNotification"/>
/// moved — <c>Narya.Twitch.EventSub.EventSubDispatcher</c> (which publishes this) already
/// references Narya.Core, and <c>Narya.Application.Chat.PersistChatModerationHandler</c> (which
/// handles it) cannot reference Narya.Twitch.
/// </summary>
public sealed record ChatModeratedNotification(ChatModerationEvent ModerationEvent) : INotification;
