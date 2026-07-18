using MediatR;

namespace Narya.Core.Automation;

/// <summary>
/// Published for a Twitch alert-shaped event (follow/sub/gift/cheer/raid) by
/// <c>Narya.Twitch.EventSub.TwitchEventSubService</c>, ALONGSIDE (never instead of) the existing
/// <c>Narya.Core.Events.StreamEventIngestedNotification</c>/<c>StreamEventUpdateIngestedNotification</c>
/// those handlers already publish — this notification is Phase 4's addition, carrying exactly what
/// <c>Narya.Application.Automation.ITriggerDispatcher.HandleTwitchEventAsync</c> needs
/// (<see cref="EventId"/> as the dedupe key, plus the structured fields a <c>twitch_event</c>
/// trigger's Action template may interpolate) that the persistence-oriented stream-event
/// notification does not carry.
///
/// <para>
/// <see cref="EventId"/> is the raw EventSub websocket message id (Twitch's own redelivery unit),
/// NOT <c>StreamEvent.Id</c> — a redelivered message must dedupe against the SAME automation run
/// even though a merged resub may reuse or update a different stream-event id. Resolved from the
/// <c>*Args.Metadata</c> the websocket transport populates
/// (<c>TwitchLib.EventSub.Websockets.Core.Models.WebsocketEventSubMetadata.MessageId</c>) — null
/// when unavailable (e.g. hand-built test fixtures), in which case
/// <c>ITriggerDispatcher.InvokeAsync</c> treats the invocation as dedupe-exempt rather than
/// crashing.
/// </para>
///
/// <para>
/// Deliberately a plain <see cref="INotification"/>, never an
/// <c>Narya.Core.Realtime.IRealtimeNotification</c> — this is an internal automation signal, not
/// content an overlay browser source should ever see directly (whatever it causes to happen is
/// itself broadcast, through the Action executor's own choke points, once the dispatcher decides to
/// fire).
/// </para>
///
/// <para>
/// Defined in <c>Narya.Core.Automation</c> (not <c>Narya.Twitch.EventSub.Notifications</c>) for the
/// same reference-direction reason <c>Narya.Core.Automod.AutomodHeldNotification</c> lives here
/// rather than there — its consumer
/// (<c>Narya.Application.Automation.TwitchEventTriggerHandler</c>) lives in Narya.Application, which
/// deliberately does not depend on Narya.Twitch's EventSub-specific notification types even though
/// it does reference the Narya.Twitch project for <c>IHelixClient</c>. Narya.Twitch already
/// references Narya.Core, so <c>EventSubDispatcher</c> publishing this type needs no new project
/// reference.
/// </para>
/// </summary>
public sealed record TwitchEventSignalNotification(
  TwitchAlertEventKind Kind,
  string? EventId,
  string Actor,
  string? Login,
  int? Amount,
  string? Tier,
  int? Months) : INotification;

/// <summary>
/// Published for <c>channel.channel_points_custom_reward_redemption.add</c> by
/// <c>Narya.Twitch.EventSub.TwitchEventSubService</c>, alongside the existing
/// <c>StreamEventIngestedNotification</c> — same rationale as <see cref="TwitchEventSignalNotification"/>.
/// <see cref="RewardId"/> is what a <c>reward</c> trigger's <c>RewardTriggerConfig.RewardId</c>
/// matches against; <see cref="UserInput"/> is the viewer's redemption text (null when the reward
/// takes no input), trimmed by
/// <c>Narya.Application.Automation.ITriggerDispatcher.HandleRewardRedemptionAsync</c>, not here.
/// </summary>
public sealed record RewardRedeemedSignalNotification(
  string? EventId,
  string RewardId,
  string RewardTitle,
  string Actor,
  string? Login,
  string? UserInput) : INotification;
