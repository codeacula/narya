using MediatR;

using Narya.Application.Chat;
using Narya.Core.Automation;

namespace Narya.Application.Automation;

/// <summary>
/// Subscribes to <see cref="ChatMessageBroadcastNotification"/> — the POST-PERSIST chat
/// notification, per the Phase 3 final-review recommendation, so a trigger only matches a message
/// that has actually made it into <c>chat_messages</c> (and therefore already survived
/// <c>PersistChatMessageHandler</c>'s redelivery-stops-here insert-or-ignore) rather than the raw
/// <c>ChatMessageIngestedNotification</c>, which fires on every redelivery. Registered via MediatR's
/// assembly scan — no explicit DI wiring needed.
/// </summary>
public sealed class ChatMessageTriggerHandler(ITriggerDispatcher dispatcher) : INotificationHandler<ChatMessageBroadcastNotification>
{
  public async Task Handle(ChatMessageBroadcastNotification notification, CancellationToken cancellationToken) =>
    _ = await dispatcher.HandleChatMessageAsync(notification.Message, cancellationToken).ConfigureAwait(false);
}

/// <summary>Subscribes to <see cref="TwitchEventSignalNotification"/> (Phase 2's EventSub dispatch layer) and calls <see cref="ITriggerDispatcher.HandleTwitchEventAsync"/>.</summary>
public sealed class TwitchEventTriggerHandler(ITriggerDispatcher dispatcher) : INotificationHandler<TwitchEventSignalNotification>
{
  public async Task Handle(TwitchEventSignalNotification notification, CancellationToken cancellationToken) =>
    _ = await dispatcher.HandleTwitchEventAsync(notification, cancellationToken).ConfigureAwait(false);
}

/// <summary>Subscribes to <see cref="RewardRedeemedSignalNotification"/> (Phase 2's EventSub dispatch layer) and calls <see cref="ITriggerDispatcher.HandleRewardRedemptionAsync"/>.</summary>
public sealed class RewardRedeemedTriggerHandler(ITriggerDispatcher dispatcher) : INotificationHandler<RewardRedeemedSignalNotification>
{
  public async Task Handle(RewardRedeemedSignalNotification notification, CancellationToken cancellationToken) =>
    _ = await dispatcher.HandleRewardRedemptionAsync(notification, cancellationToken).ConfigureAwait(false);
}
