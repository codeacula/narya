using MediatR;

using Narya.Core.Dashboard;
using Narya.Core.Realtime;

namespace Narya.Application.Dashboard;

/// <summary>
/// Published once per tick by <c>Narya.Api.Dashboard.DashboardHeartbeatService</c>. Implements
/// <see cref="IRealtimeNotification"/> so <c>Narya.Application.Realtime.RealtimeBridgeHandler{T}</c>
/// (registered as an open generic — no extra wiring needed here) forwards it to
/// <see cref="IRealtimePublisher"/> under the <c>dashboard:status</c> event name legacy's
/// <c>broadcast('dashboard:status', ...)</c> used.
///
/// Deliberately NOT added to <see cref="RealtimeEventNames.OverlayAllowlist"/> — operator-only,
/// per the Phase 3 plan's realtime allowlist ("<c>automod:held</c>/<c>automod:resolved</c>/
/// <c>dashboard:status</c>/<c>whisper:message</c> operator-only"): the snapshot carries auth
/// token expiry and EventSub error detail an overlay browser source has no business seeing.
/// </summary>
public sealed record DashboardStatusBroadcastNotification(DashboardStatus Status) : INotification, IRealtimeNotification
{
  public string EventName => "dashboard:status";

  public object Payload => Status;
}
