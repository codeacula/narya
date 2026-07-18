namespace Narya.Core.Realtime;

/// <summary>
/// Which realtime events an <c>overlay</c>-role SignalR connection may receive. Operators
/// receive every event unconditionally; overlays receive only events named here — see
/// <c>Narya.Api.Realtime.RealtimeBroadcastService</c>, which forwards each Redis envelope
/// to the <c>operator</c> group always, and to the <c>overlay</c> group only when
/// <see cref="OverlayAllowlist"/> contains the event name.
///
/// Phase 1 published exactly one event, <c>settings:updated</c>, which is operator-only
/// (an overlay browser source has no use for runtime config), so this started empty.
/// Phase 2 (Task 6) adds the four EventSub-sourced events an overlay browser source
/// actually renders: <c>chat:message</c>/<c>chat:moderated</c> (the chat overlay, which
/// hides moderated messages entirely rather than showing the reason) and
/// <c>stream:event</c>/<c>stream:event:update</c> (the shoutout ticker). Future phases add
/// more as each event ships — do not pre-populate ahead of the endpoint that actually
/// emits it. <c>whisper:message</c> is deliberately NOT here: a whisper is private
/// correspondence with the operator, not something an overlay browser source should ever
/// render (see <c>Narya.Twitch.EventSub.Notifications.WhisperReceivedNotification</c>).
/// The legacy <c>OVERLAY_EVENTS</c> allowlist (<c>legacy/src/server/auth.ts</c>) enumerates
/// what eventually belongs here:
///   chat:message, chat:moderated, music:updated, sound:play, media:play, tts:speak,
///   overlay:text, stream:event, stream:event:update, status:updated,
///   overlay:placeholders
/// </summary>
public static class RealtimeEventNames
{
  public static readonly IReadOnlySet<string> OverlayAllowlist = new HashSet<string>(
    ["chat:message", "chat:moderated", "stream:event", "stream:event:update"],
    StringComparer.Ordinal);
}
