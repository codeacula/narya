using MediatR;

using Narya.Core.Automod;

namespace Narya.Application.Automod;

/// <summary>
/// Resolves a previously held message from Twitch's own EventSub verdict — a port of legacy's
/// <c>eventsub.ts</c> <c>automod.message.update</c> handler. This is the system of record, so it
/// resolves with the highest precedence (<see cref="AutomodResolutionSource.EventSub"/>): it can
/// overturn both a speculative "expired" and a contradictory dashboard verdict, and nothing can
/// overturn it — see <see cref="IAutomodStore.ResolveHoldAsync"/>'s doc comment.
/// </summary>
public sealed class ResolveAutomodHoldHandler(IAutomodStore automodStore, IMediator mediator)
  : INotificationHandler<AutomodResolvedNotification>
{
  public async Task Handle(AutomodResolvedNotification notification, CancellationToken cancellationToken)
  {
    var resolution = NormalizeStatus(notification.Status);
    var resolvedBy = string.IsNullOrEmpty(notification.ModeratorUserName) ? null : notification.ModeratorUserName;

    var result = await automodStore.ResolveHoldAsync(
      notification.MessageId, resolution, resolvedBy, AutomodResolutionSource.EventSub, cancellationToken).ConfigureAwait(false);

    // Changed is false for an unknown id, or when this verdict was redundant (the same resolution
    // an equal-or-higher-precedence source already stored) — neither broadcasts, matching
    // legacy's resolveAutomodHold, which only broadcasts on an actual row change.
    if (result is { Changed: true, Hold: not null })
    {
      await mediator.Publish(new AutomodResolvedBroadcastNotification(result.Hold), cancellationToken).ConfigureAwait(false);
    }
  }

  /// <summary>
  /// Twitch delivers <c>Approved</c>/<c>Denied</c>/<c>Expired</c> — normalized case-insensitively
  /// to legacy's <c>allowed</c>/<c>denied</c>/<c>expired</c> resolution vocabulary. An
  /// unrecognized value defaults to <c>expired</c>, matching legacy's defensive fallback
  /// (<c>legacy/src/server/eventsub.ts</c>: "treating as expired").
  /// </summary>
  private static string NormalizeStatus(string status) => status.ToUpperInvariant() switch
  {
    "APPROVED" => "allowed",
    "DENIED" => "denied",
    "EXPIRED" => "expired",
    _ => "expired",
  };
}
