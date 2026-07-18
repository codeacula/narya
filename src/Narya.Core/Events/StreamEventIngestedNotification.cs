using MediatR;

namespace Narya.Core.Events;

/// <summary>
/// Published by <c>Narya.Twitch.EventSub.EventSubDispatcher</c>'s follow/sub/gift/cheer/raid/
/// redeem/ad_break/watch-streak dispatch methods, via <c>TwitchEventSubService</c>. Deliberately
/// a plain <see cref="INotification"/>, NOT an <c>Narya.Core.Realtime.IRealtimeNotification</c> —
/// this is the "ingested" half of Phase 3 Task 4's ingested→broadcast split (see
/// <see cref="StreamEvent"/>'s doc comment). Broadcasting the raw event the instant it arrives
/// would race <c>Narya.Application.Events.PersistStreamEventHandler</c>, which needs to look up
/// the active stream session before anyone downstream should see <see cref="StreamEvent.SessionId"/>.
/// That handler is this notification's only consumer; once it has persisted the event and
/// computed the real <see cref="StreamEvent.SessionId"/>, it republishes the enriched copy as
/// <c>Narya.Application.Events.StreamEventBroadcastNotification</c> (event name
/// <c>stream:event</c>), which the Phase 1 realtime bridge
/// (<c>Narya.Application.Realtime.RealtimeBridgeHandler&lt;T&gt;</c>) broadcasts.
///
/// Originally named <c>StreamEventOccurredNotification</c> and defined in
/// <c>Narya.Twitch.EventSub.Notifications</c> as an <c>IRealtimeNotification</c> (Phase 2, direct
/// broadcast); renamed and moved here in Task 4 for the same reference-direction reason
/// <see cref="StreamEvent"/> moved — <c>Narya.Twitch.EventSub.EventSubDispatcher</c> (which
/// publishes this) already references Narya.Core, and
/// <c>Narya.Application.Events.PersistStreamEventHandler</c> (which handles it) cannot reference
/// Narya.Twitch.
/// </summary>
public sealed record StreamEventIngestedNotification(StreamEvent Event) : INotification;
