namespace Narya.Core.Events;

/// <summary>
/// A stream-lifetime event for the dashboard's event feed and the shoutout ticker — a port of
/// legacy's <c>StreamEvent</c> (<c>legacy/src/shared/api.ts</c>). <see cref="Id"/> is either a
/// fresh <see cref="Guid"/> (follow/sub/gift/cheer/raid/ad_break — Twitch gives none of these a
/// stable identifier at this layer) or, for <see cref="Kind"/> <c>"redeem"</c>, the Twitch
/// redemption id itself — see <c>Narya.Twitch.EventSub.EventSubDispatcher.DispatchRedemption</c>'s
/// doc comment for why that dedup key matters to a later phase's <c>automation_runs</c>.
///
/// <see cref="ActorLogin"/>/<see cref="SessionId"/>/<see cref="Ago"/> default null on the RAW,
/// ingested event — <c>EventSubDispatcher</c> is a pure translation with no database access, so
/// it cannot know the active stream session or format a relative time; it only ever supplies
/// <see cref="ActorLogin"/>, straight from whichever Twitch <c>*_login</c> field the event
/// carries, UNlowercased — matches legacy's <c>loginOf()</c>, which does not lowercase either.
/// <c>Narya.Application.Events.PersistStreamEventHandler</c> is what lowercases it (mirroring
/// legacy's <c>emitStreamEvent</c>), stamps the real <see cref="SessionId"/>, and republishes an
/// enriched copy as <c>Narya.Application.Events.StreamEventBroadcastNotification</c> — the
/// ingested→broadcast split this record enables (the same restructure
/// <c>Narya.Core.Chat.ChatMessage</c> went through in Task 1).
///
/// <see cref="Ago"/> is wire-only — never persisted (see
/// <c>Narya.Database.Events.StreamEventDocument</c>, which has no <c>Ago</c> column). Set to the
/// literal <c>"just now"</c> by <c>PersistStreamEventHandler</c> on a freshly-ingested broadcast
/// (matching legacy's <c>emitStreamEvent</c>, which hardcodes the same literal rather than
/// calling <c>formatAgo</c>), and to a computed relative time
/// (<c>Narya.Application.Events.RelativeTime.FormatAgo</c>) by
/// <c>GetRecentStreamEventsQueryHandler</c> for <c>GET /api/dashboard/events</c>.
///
/// <see cref="ActorLogin"/> is additive relative to legacy's shared <c>StreamEvent</c> wire type
/// (which has no such field — the column exists in <c>stream_events</c> but is never read back
/// into a response) — the same kind of internal-only addition
/// <c>Narya.Core.Chat.ChatMessage.ChatterUserId</c> already is, so it rides along on the wire
/// without a legacy shape to match.
///
/// Originally defined in <c>Narya.Twitch.EventSub.Notifications</c> (Phase 2, with only
/// <see cref="Id"/>/<see cref="Kind"/>/<see cref="Actor"/>/<see cref="Detail"/>/<see cref="Tone"/>/
/// <see cref="ReceivedAt"/> — no <see cref="ActorLogin"/>/<see cref="SessionId"/>/<see cref="Ago"/>
/// at all); moved here and extended in Phase 3 Task 4 for the same reference-direction reason
/// <c>ChatMessage</c> moved: <c>Narya.Application.Events.PersistStreamEventHandler</c> lives in
/// Narya.Application, and Narya.Application deliberately does not reference Narya.Twitch. The
/// three new fields are appended at the end, all defaulted, so every existing positional call
/// site (<c>EventSubDispatcher</c>'s <c>new StreamEvent(id, kind, actor, detail, tone, now)</c>
/// calls) keeps compiling unchanged.
/// </summary>
public sealed record StreamEvent(
  string Id,
  string Kind,
  string Actor,
  string Detail,
  string Tone,
  DateTimeOffset ReceivedAt,
  string? ActorLogin = null,
  string? SessionId = null,
  string? Ago = null);

/// <summary>
/// An in-place update to a previously emitted <see cref="StreamEvent"/> — used exclusively by
/// the subscribe/subscription.message merge (twitchlib-spec.md §3.5): Twitch fires both
/// <c>channel.subscribe</c> and <c>channel.subscription.message</c> for a resub with a message,
/// in no guaranteed order, and legacy (<c>legacy/src/server/eventsub.ts</c>'s
/// <c>updateStreamEvent</c>) updates the row in place rather than emitting a second one. Moved
/// alongside <see cref="StreamEvent"/> — see that record's doc comment for why.
/// </summary>
public sealed record StreamEventUpdate(string Id, string Detail, string Tone);
