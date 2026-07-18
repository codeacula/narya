using Narya.Application.Actions;
using Narya.Core.Actions;
using Narya.Core.Automation;
using Narya.Core.Chat;

namespace Narya.Application.Automation;

/// <summary>One armed-and-claimed trigger invocation's outcome — a port of legacy's <c>TriggerRunSummary</c>.</summary>
public sealed record TriggerRunSummary(Guid TriggerId, Guid ActionId, ActionRunResult Result);

/// <summary>
/// <see cref="ITriggerDispatcher.InvokeAsync"/>'s options — a port of legacy's inline
/// <c>InvokeOptions</c>. <see cref="EventId"/> is the source event's own id (a chat message id, an
/// EventSub message id) and becomes half of the dedupe key; <see langword="null"/> (the default) is
/// how a manual run or a module-lifecycle invocation opts OUT of dedup entirely — see
/// <c>Narya.Core.Automation.IAutomationRunStore.TryClaimAsync</c>'s doc comment. <see cref="EnforceGates"/>
/// false (manual runs, module-lifecycle invocations) skips <c>IsArmed</c>/cooldown but never skips
/// the dedup claim itself.
/// </summary>
public sealed record TriggerInvokeOptions
{
  public string? EventId { get; init; }

  public string? ActorLogin { get; init; }

  public bool EnforceGates { get; init; } = true;
}

/// <summary>Which direction a category module (Phase 8) lifecycle transition fired — a port of legacy's <c>ModuleLifecyclePhase</c>.</summary>
public enum ModuleLifecyclePhase
{
  Activate = 0,
  Deactivate = 1,
}

/// <summary>
/// Matches Twitch/chat/dashboard events against configured <c>Narya.Core.Automation.AutomationTrigger</c>s
/// and fires their Actions exactly once per source event — a port of legacy's
/// <c>createTriggerDispatcher</c> (<c>legacy/src/server/triggerDispatcher.ts</c>). A PLAIN service,
/// deliberately NOT a MediatR handler itself: <c>Narya.Application.Automation.ChatMessageTriggerHandler</c>/
/// <c>TwitchEventTriggerHandler</c>/<c>RewardRedeemedTriggerHandler</c> are the thin
/// <c>INotificationHandler&lt;T&gt;</c> shells that subscribe to the relevant Phase 2/3 notifications
/// and call into this. Implemented by <see cref="TriggerDispatcher"/>; registered
/// <c>AddSingleton&lt;ITriggerDispatcher, TriggerDispatcher&gt;</c> (unguarded, same reasoning as
/// <c>Narya.Application.Actions.IActionExecutor</c> — the dispatcher itself needs no infrastructure,
/// only some of its injected dependencies do).
/// </summary>
public interface ITriggerDispatcher
{
  /// <summary>
  /// The choke point every other method here funnels through: <paramref name="options"/>'s
  /// <c>EnforceGates</c> (default <see langword="true"/>) gates <c>IsArmed</c> and the cooldown
  /// check; the dedup claim (<c>IAutomationRunStore.TryClaimAsync</c>) always runs regardless.
  /// Returns <see langword="null"/> when the trigger is not armed, is on cooldown, or the claim lost
  /// a dedup race — in every one of those cases the Action never runs. A thrown exception from the
  /// Action executor is caught here (one of this codebase's two deliberate, documented exceptions
  /// to its no-blanket-catch rule — see the Phase 4 plan's Global Constraints) and folded into a
  /// <see cref="ActionRunStatus.Failed"/> summary rather than propagating.
  /// </summary>
  Task<TriggerRunSummary?> InvokeAsync(
    AutomationTrigger trigger, TemplateContext context, TriggerInvokeOptions? options, CancellationToken cancellationToken);

  /// <summary>
  /// Matches an ingested chat message against every enabled <c>chat_phrase</c>/<c>viewer_command</c>
  /// trigger and invokes all of them (sequentially — one message legitimately drives several
  /// Actions, and cooldowns are the throttle, not first-match-wins). The BOT-LOOP GUARD runs first:
  /// a message from the configured bot account never matches anything, or a <c>send_chat</c> step
  /// whose own text happens to match a phrase trigger would re-trigger itself forever.
  /// </summary>
  Task<IReadOnlyList<TriggerRunSummary>> HandleChatMessageAsync(ChatMessage message, CancellationToken cancellationToken);

  /// <summary>Matches every enabled <c>twitch_event</c> trigger whose configured kind equals <paramref name="signal"/>'s and invokes all of them.</summary>
  Task<IReadOnlyList<TriggerRunSummary>> HandleTwitchEventAsync(TwitchEventSignalNotification signal, CancellationToken cancellationToken);

  /// <summary>Matches every enabled <c>reward</c> trigger whose configured reward id equals <paramref name="signal"/>'s and invokes all of them.</summary>
  Task<IReadOnlyList<TriggerRunSummary>> HandleRewardRedemptionAsync(RewardRedeemedSignalNotification signal, CancellationToken cancellationToken);

  /// <summary>
  /// Matches every enabled <c>module_activate</c>/<c>module_deactivate</c> trigger scoped to
  /// <paramref name="moduleId"/> (or global) and invokes all of them with <c>EnforceGates: false</c>
  /// — a lifecycle trigger fires by definition of the transition happening, not by the module being
  /// "armed" (a deactivate trigger must still fire once its module has gone away). Phase 8 wires the
  /// caller; this method exists now so its shape is settled.
  /// </summary>
  Task<IReadOnlyList<TriggerRunSummary>> HandleModuleLifecycleAsync(
    ModuleLifecyclePhase phase, Guid moduleId, string? moduleName, CancellationToken cancellationToken);

  /// <summary>
  /// The operator's explicit "run this trigger now" action (<c>POST /api/automation/triggers/{id}/run</c>)
  /// — <c>EnforceGates: false</c> (cooldowns/arming bypassed) but still dedup-claimed with a
  /// <see langword="null"/> event id, so it never collides with anything. Returns
  /// <see langword="null"/> only when <paramref name="triggerId"/> does not exist (the caller 404s).
  /// </summary>
  Task<ActionRunResult?> RunTriggerManuallyAsync(Guid triggerId, TemplateContext context, CancellationToken cancellationToken);

  /// <summary>
  /// The operator's private dashboard command bar (<c>POST /api/automation/slash</c>) — resolves
  /// <paramref name="input"/> to a configured <c>dashboard_slash</c> trigger or rejects it, and
  /// NEVER forwards anything to Twitch chat itself: every path returns a local
  /// <see cref="SlashCommandResponse"/>, including an unknown command or a typo. See this method's
  /// implementation for the exact context convention (<c>{actor}</c>/<c>{login}</c> bind to the
  /// command's TARGET argument, not the operator).
  /// </summary>
  Task<SlashCommandResponse> HandleSlashCommandAsync(string? input, CancellationToken cancellationToken);
}
