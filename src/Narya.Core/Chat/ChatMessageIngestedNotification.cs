using MediatR;

namespace Narya.Core.Chat;

/// <summary>
/// Published whenever <c>Narya.Twitch.EventSub.EventSubDispatcher.DispatchChatMessage</c>
/// returns non-null (i.e. the message was not the bot's own — see that method's bot-loop
/// guard). Deliberately a plain <see cref="INotification"/>, NOT an
/// <c>Narya.Core.Realtime.IRealtimeNotification</c> — this is the "ingested" half of Phase 3's
/// ingested→broadcast split (see <see cref="ChatMessage"/>'s doc comment). Broadcasting the raw,
/// un-enriched message the instant it arrives would race the persistence/enrichment handler
/// (<c>Narya.Application.Chat.PersistChatMessageHandler</c>), which needs to look up the
/// chatter's history and the active stream session before anyone downstream should see
/// <see cref="ChatMessage.IsFirstEver"/>/<see cref="ChatMessage.IsFirstThisSession"/>/
/// <see cref="ChatMessage.SessionId"/>. That handler is this notification's only consumer; once
/// it has computed the real values, it republishes the enriched copy as
/// <c>Narya.Application.Chat.ChatMessageBroadcastNotification</c> (event name <c>chat:message</c>),
/// which the Phase 1 realtime bridge (<c>Narya.Application.Realtime.RealtimeBridgeHandler&lt;T&gt;</c>)
/// broadcasts.
///
/// Originally named <c>ChatMessageReceivedNotification</c> and defined in
/// <c>Narya.Twitch.EventSub.Notifications</c> as an <c>IRealtimeNotification</c> (Phase 2);
/// renamed and moved here in Phase 3 for the same reference-direction reason
/// <see cref="ChatMessage"/> moved — <c>Narya.Twitch.EventSub.EventSubDispatcher</c> (which
/// publishes this) already references Narya.Core, and
/// <c>Narya.Application.Chat.PersistChatMessageHandler</c> (which handles it) cannot reference
/// Narya.Twitch.
/// </summary>
public sealed record ChatMessageIngestedNotification(ChatMessage Message) : INotification;
