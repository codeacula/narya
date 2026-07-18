using MediatR;

namespace Narya.Twitch.EventSub.Notifications;

/// <summary>
/// Published for <c>channel.update</c>. Deliberately plain <see cref="INotification"/> — NOT
/// <see cref="Narya.Core.Realtime.IRealtimeNotification"/> — because this carries the raw
/// Twitch category, not something a client renders directly; Phase 8's category-module
/// coordinator is the consumer (<c>onCategorySignal</c> in legacy), and it decides what, if
/// anything, gets broadcast from there. No handler exists yet in Phase 2, so publishing this is
/// a documented no-op until Phase 8 adds one — see <c>EventSubDispatcherTests</c> for the proof
/// that a canned <c>channel.update</c> payload maps to this shape.
/// </summary>
public sealed record CategorySignalNotification(string? GameId, string? GameName) : INotification;

// StreamOnlineNotification/StreamOfflineNotification (originally defined here for
// stream.online/stream.offline) moved to Narya.Core.Sessions in Phase 3 — their consumers
// (Narya.Application.Sessions's handlers) live in an assembly that does not reference
// Narya.Twitch. See StreamOnlineNotification's doc comment in that new location for the
// full rationale. EventSubDispatcher.DispatchStreamOnline/DispatchStreamOffline below still
// produce them, just from the new namespace.

/// <summary>
/// Published for <c>automod.message.hold</c> (v2). Phase 3 consumes this to populate the
/// AutoMod held-message queue (<c>recordAutomodHold</c> in legacy).
/// </summary>
public sealed record AutomodHeldNotification(
  string MessageId,
  string Username,
  string DisplayName,
  string Message,
  string Reason,
  DateTimeOffset HeldAt) : INotification;

/// <summary>
/// Published for <c>automod.message.update</c> (v2). Phase 3 consumes this to resolve a
/// previously held message (<c>resolveAutomodHold</c> in legacy). <see cref="Status"/> is
/// Twitch's raw value (<c>Approved</c>/<c>Denied</c>/<c>Expired</c>) — normalizing it to
/// legacy's <c>allowed</c>/<c>denied</c>/<c>expired</c> resolution vocabulary is Phase 3's job,
/// same as the rest of the persistence this notification feeds.
/// </summary>
public sealed record AutomodResolvedNotification(string MessageId, string Status, string ModeratorUserName) : INotification;
