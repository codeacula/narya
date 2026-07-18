using MediatR;

using Narya.Core.Realtime;

namespace Narya.Twitch.EventSub.Notifications;

/// <summary>
/// A stream-lifetime event for the dashboard's event feed and the shoutout ticker — a port of
/// legacy's <c>StreamEvent</c> (<c>legacy/src/shared/api.ts</c>). <see cref="Id"/> is either a
/// fresh <see cref="Guid"/> (follow/sub/gift/cheer/raid/ad_break — Twitch gives none of these a
/// stable identifier at this layer) or, for <see cref="Kind"/> <c>"redeem"</c>, the Twitch
/// redemption id itself: twitchlib-spec.md §3.5 calls out that "redemption dedup keys off the
/// **redemption id** (not a transport id)", so <see cref="EventSubDispatcher.DispatchRedemption"/>
/// reuses that same id here rather than minting an unrelated one, giving Phase 4's
/// <c>automation_runs</c> dedup a stable, meaningful id to key off later.
/// </summary>
public sealed record StreamEvent(
  string Id,
  string Kind,
  string Actor,
  string Detail,
  string Tone,
  DateTimeOffset ReceivedAt);

/// <summary>
/// An in-place update to a previously emitted <see cref="StreamEvent"/> — used exclusively by
/// the subscribe/subscription.message merge (twitchlib-spec.md §3.5): Twitch fires both
/// <c>channel.subscribe</c> and <c>channel.subscription.message</c> for a resub with a message,
/// in no guaranteed order, and legacy (<c>legacy/src/server/eventsub.ts</c>'s
/// <c>updateStreamEvent</c>) updates the row in place rather than emitting a second one.
/// </summary>
public sealed record StreamEventUpdate(string Id, string Detail, string Tone);

/// <summary>Broadcasts as <c>stream:event</c>, allowlisted for overlays (the shoutout ticker).</summary>
public sealed record StreamEventOccurredNotification(StreamEvent Event) : INotification, IRealtimeNotification
{
  public string EventName => "stream:event";

  public object Payload => Event;
}

/// <summary>Broadcasts as <c>stream:event:update</c>, allowlisted for overlays — see <see cref="StreamEventUpdate"/>.</summary>
public sealed record StreamEventUpdatedNotification(StreamEventUpdate Update) : INotification, IRealtimeNotification
{
  public string EventName => "stream:event:update";

  public object Payload => Update;
}
