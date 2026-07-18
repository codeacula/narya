using MediatR;

using Narya.Core.Automod;

namespace Narya.Application.Automod;

/// <summary>
/// Resolves a previously held message authoritatively — a port of legacy's <c>eventsub.ts</c>
/// <c>automod.message.update</c> handler, sourced from Twitch's own EventSub verdict (never
/// speculative — <c>authoritative: true</c> here can overturn a locally-recorded speculative
/// "expired" exactly once; see <see cref="IAutomodStore.ResolveHoldAsync"/>'s doc comment).
/// </summary>
public sealed class ResolveAutomodHoldHandler(IAutomodStore automodStore, IMediator mediator)
  : INotificationHandler<AutomodResolvedNotification>
{
  public async Task Handle(AutomodResolvedNotification notification, CancellationToken cancellationToken)
  {
    var resolution = NormalizeStatus(notification.Status);
    var resolvedBy = string.IsNullOrEmpty(notification.ModeratorUserName) ? null : notification.ModeratorUserName;

    var result = await automodStore.ResolveHoldAsync(
      notification.MessageId, resolution, resolvedBy, authoritative: true, cancellationToken).ConfigureAwait(false);

    // Changed is false for an unknown id, or when this authoritative verdict lost a race (or
    // arrived redundantly) against an already-resolved hold — neither broadcasts, matching
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
