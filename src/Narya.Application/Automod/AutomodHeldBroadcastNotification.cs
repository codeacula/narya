using MediatR;

using Narya.Core.Automod;
using Narya.Core.Realtime;

namespace Narya.Application.Automod;

/// <summary>
/// The "broadcast" half of Task 6's ingested→broadcast split for AutoMod holds — mirrors
/// <c>Narya.Application.Chat.ChatMessageBroadcastNotification</c>. Published by
/// <see cref="RecordAutomodHoldHandler"/> only after <c>IAutomodStore.RecordHoldAsync</c> has
/// confirmed a genuine insert (never for a redelivered hold id). Implements
/// <see cref="IRealtimeNotification"/> so <c>Narya.Application.Realtime.RealtimeBridgeHandler{T}</c>
/// (registered as an open generic — no extra wiring needed here) forwards it to
/// <see cref="IRealtimePublisher"/> under the <c>automod:held</c> event name legacy's
/// <c>broadcast('automod:held', ...)</c> used.
///
/// Deliberately NOT added to <see cref="RealtimeEventNames.OverlayAllowlist"/> — moderated
/// content (a held message's text, category, level) must never reach an overlay browser source;
/// matches legacy's <c>OVERLAY_EVENTS</c>, which never included <c>automod:held</c> either.
/// </summary>
public sealed record AutomodHeldBroadcastNotification(AutomodHold Hold) : INotification, IRealtimeNotification
{
  public string EventName => "automod:held";

  public object Payload => Hold;
}
