using MediatR;

using Narya.Core.Realtime;

namespace Narya.Twitch.EventSub.Notifications;

/// <summary>A whisper sent to the broadcaster or bot account — a port of legacy's <c>WhisperMessage</c>.</summary>
public sealed record WhisperMessage(string Id, string FromLogin, string FromDisplayName, string Text, DateTimeOffset ReceivedAt);

/// <summary>
/// Broadcasts as <c>whisper:message</c>. Deliberately NOT added to
/// <see cref="RealtimeEventNames.OverlayAllowlist"/> — a whisper is private correspondence with
/// the operator, and an overlay browser source has no business rendering it (matches legacy's
/// <c>OVERLAY_EVENTS</c>, which never included it either).
/// </summary>
public sealed record WhisperReceivedNotification(WhisperMessage Whisper) : INotification, IRealtimeNotification
{
  public string EventName => "whisper:message";

  public object Payload => Whisper;
}
