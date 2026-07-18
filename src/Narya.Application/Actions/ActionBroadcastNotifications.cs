using MediatR;

using Narya.Core.Actions;
using Narya.Core.Media;
using Narya.Core.Realtime;

namespace Narya.Application.Actions;

/// <summary>
/// Published by <see cref="ActionExecutor"/> when a <c>show_text</c> step's rendered text is
/// non-blank. Implements <see cref="IRealtimeNotification"/> so
/// <see cref="Narya.Application.Realtime.RealtimeBridgeHandler{T}"/> (registered as an open
/// generic — no extra wiring needed here) forwards it to <see cref="IRealtimePublisher"/> under
/// the <c>overlay:text</c> event name the <c>/overlay/text</c> browser source subscribes to. This
/// carries the RESOLVED <see cref="OverlayTextPlayback"/> only — never the step's raw template —
/// matching legacy's <c>emit('overlay:text', playback)</c>.
/// </summary>
public sealed record OverlayTextBroadcastNotification(OverlayTextPlayback Playback) : INotification, IRealtimeNotification
{
  public string EventName => "overlay:text";

  public object Payload => Playback;
}

/// <summary>
/// Published by <see cref="ActionExecutor"/> when a <c>play_media</c> step resolves a playable
/// asset through <see cref="IMediaResolver"/> — THE single media playback choke point. Implements
/// <see cref="IRealtimeNotification"/> so <see cref="Realtime.RealtimeBridgeHandler{T}"/>
/// forwards it to <see cref="IRealtimePublisher"/> under the <c>media:play</c> event name
/// <c>/overlay/clips</c> subscribes to, matching legacy's <c>playMedia()</c>/<c>broadcast('media:play', payload)</c>.
/// </summary>
public sealed record MediaPlayBroadcastNotification(MediaPlayback Playback) : INotification, IRealtimeNotification
{
  public string EventName => "media:play";

  public object Payload => Playback;
}
