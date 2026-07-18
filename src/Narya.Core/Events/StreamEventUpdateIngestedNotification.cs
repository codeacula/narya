using MediatR;

namespace Narya.Core.Events;

/// <summary>
/// Published by the subscribe/subscription.message merge path (see
/// <see cref="StreamEventUpdate"/>'s doc comment) when a pending "new sub" stream event should be
/// updated in place rather than duplicated. Deliberately a plain <see cref="INotification"/>, NOT
/// an <c>Narya.Core.Realtime.IRealtimeNotification</c> — the "ingested" half of Task 4's
/// ingested→broadcast split for the sub-merge update: legacy always updated the stored row
/// BEFORE broadcasting (<c>legacy/src/server/eventsub.ts</c>'s <c>updateStreamEvent</c>), and this
/// notification's only consumer, <c>Narya.Application.Events.UpdateStreamEventHandler</c>,
/// preserves that ordering — it applies the update to the stored <c>stream_events</c> row first,
/// then republishes <c>Narya.Application.Events.StreamEventUpdateBroadcastNotification</c> (event
/// name <c>stream:event:update</c>), which the Phase 1 realtime bridge broadcasts.
///
/// Originally named <c>StreamEventUpdatedNotification</c> and defined in
/// <c>Narya.Twitch.EventSub.Notifications</c> as an <c>IRealtimeNotification</c> (Phase 2, direct
/// broadcast with no persistence at all); renamed and moved here in Task 4 for the same
/// reference-direction reason <see cref="StreamEvent"/> moved.
/// </summary>
public sealed record StreamEventUpdateIngestedNotification(StreamEventUpdate Update) : INotification;
