using MediatR;

using Narya.Core.Automod;
using Narya.Core.Realtime;

namespace Narya.Application.Automod;

/// <summary>
/// The "broadcast" half of Task 6's ingested→broadcast split for AutoMod resolutions. Published
/// by <see cref="ResolveAutomodHoldHandler"/> (the authoritative EventSub verdict) and by
/// <c>Narya.Api.Controllers.AutomodController</c>'s allow/deny routes, both only when
/// <c>IAutomodStore.ResolveHoldAsync</c> reports <c>Changed: true</c> — a no-op resolution
/// (already resolved, or a non-authoritative call against a resolved hold) never broadcasts,
/// matching legacy's <c>resolveAutomodHold</c>, which only calls <c>broadcast('automod:resolved', ...)</c>
/// when its <c>UPDATE</c> actually changed a row.
///
/// Deliberately NOT added to <see cref="RealtimeEventNames.OverlayAllowlist"/> — same rationale
/// as <see cref="AutomodHeldBroadcastNotification"/>.
/// </summary>
public sealed record AutomodResolvedBroadcastNotification(AutomodHold Hold) : INotification, IRealtimeNotification
{
  public string EventName => "automod:resolved";

  public object Payload => Hold;
}
