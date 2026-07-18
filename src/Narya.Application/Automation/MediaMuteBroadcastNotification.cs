using MediatR;

using Narya.Core.Automation;
using Narya.Core.Realtime;

namespace Narya.Application.Automation;

/// <summary>
/// Published by <see cref="SetMediaMuteCommandHandler"/> AFTER the store write commits
/// (persist-before-broadcast — see that handler's doc comment). Implements
/// <see cref="IRealtimeNotification"/> so <see cref="Narya.Application.Realtime.RealtimeBridgeHandler{T}"/>
/// forwards it to <see cref="IRealtimePublisher"/> under the <c>media:mute</c> event name, matching
/// legacy's <c>broadcast('media:mute', state)</c> — so every operator dashboard/tablet reflects the
/// switch without a manual refresh.
///
/// <para>
/// <c>media:mute</c> is deliberately NOT in <see cref="RealtimeEventNames.OverlayAllowlist"/> — an
/// overlay browser source has no business reading or flipping the master mute switch, only
/// rendering (or not rendering, once muted) whatever an Action's steps already broadcast. See
/// <c>RealtimeRoutingTests.MediaMuteRoutesToTheOperatorGroupOnlyAgainstTheRealAllowlist</c>.
/// </para>
/// </summary>
public sealed record MediaMuteBroadcastNotification(MediaMuteState State) : INotification, IRealtimeNotification
{
  public string EventName => "media:mute";

  public object Payload => State;
}
