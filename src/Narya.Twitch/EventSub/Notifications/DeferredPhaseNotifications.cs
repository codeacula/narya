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

// AutomodHeldNotification/AutomodResolvedNotification (originally defined here for
// automod.message.hold/automod.message.update) moved to Narya.Core.Automod in Phase 3 Task 6
// for the same reference-direction reason — their consumers
// (Narya.Application.Automod.RecordAutomodHoldHandler/ResolveAutomodHoldHandler) live in an
// assembly that does not reference Narya.Twitch. See AutomodHeldNotification's doc comment in
// that new location for the full rationale, including the additive Channel/Category/Level
// fields. EventSubDispatcher.DispatchAutomodHold/DispatchAutomodUpdate below still produce
// them, just from the new namespace.
