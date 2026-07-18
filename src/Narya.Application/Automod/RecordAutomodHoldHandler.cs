using MediatR;

using Narya.Core.AppConfig;
using Narya.Core.Automod;

namespace Narya.Application.Automod;

/// <summary>
/// Persists every ingested AutoMod hold and broadcasts it — a port of legacy's
/// <c>eventsub.ts</c> <c>automod.message.hold</c> handler + <c>automod.ts</c>'s
/// <c>recordAutomodHold</c>.
/// </summary>
public sealed class RecordAutomodHoldHandler(IAutomodStore automodStore, IAppConfigStore appConfigStore, IMediator mediator)
  : INotificationHandler<AutomodHeldNotification>
{
  public async Task Handle(AutomodHeldNotification notification, CancellationToken cancellationToken)
  {
    var channel = await ResolveChannelAsync(notification.Channel, cancellationToken).ConfigureAwait(false);
    var username = string.IsNullOrEmpty(notification.Username) ? "unknown" : notification.Username;
    var displayName = string.IsNullOrEmpty(notification.DisplayName) ? username : notification.DisplayName;

    var hold = new AutomodHold(
      Id: notification.MessageId,
      Channel: channel,
      Username: username,
      DisplayName: displayName,
      Message: notification.Message,
      Category: notification.Category,
      Level: notification.Level,
      HeldAt: notification.HeldAt);

    // Insert-or-ignore: a redelivered hold id stops here — no broadcast, matching
    // IAutomodStore.RecordHoldAsync's doc comment.
    var inserted = await automodStore.RecordHoldAsync(hold, cancellationToken).ConfigureAwait(false);
    if (!inserted)
    {
      return;
    }

    await mediator.Publish(new AutomodHeldBroadcastNotification(hold), cancellationToken).ConfigureAwait(false);
  }

  /// <summary>
  /// Mirrors legacy's <c>event.broadcaster_user_login ?? appConfig.twitchChannel</c> — the pure
  /// <c>EventSubDispatcher</c> cannot perform this config lookup itself (twitchlib-spec.md
  /// §3.5/§4), so it hands through Twitch's raw (possibly empty) login and this handler applies
  /// the fallback. A store failure here falls back to an empty channel rather than throwing,
  /// same rationale as <c>PersistChatMessageHandler.IsChannelOwnerAsync</c>.
  /// </summary>
  private async Task<string> ResolveChannelAsync(string rawChannel, CancellationToken cancellationToken)
  {
    if (!string.IsNullOrEmpty(rawChannel))
    {
      return rawChannel;
    }

    var configResult = await appConfigStore.GetAsync(cancellationToken).ConfigureAwait(false);
    return configResult.IsFailed ? string.Empty : configResult.Value.TwitchChannel;
  }
}
