using FluentResults;

using Narya.Core.Automation;

namespace Narya.Core.Actions;

/// <summary>
/// One <c>Narya.Core.Automation.AutomationTrigger</c> that references an
/// <see cref="AutomationAction"/>, reduced to what an operator needs in order to find and repoint
/// it: its id, a human-readable name, and its kind. Carried by <see cref="ActionInUseError"/> and
/// rendered by the dashboard's "used by N triggers" message.
///
/// <para>
/// Lives here (Narya.Core) rather than in the controller or the store so the 409 body and the
/// store's failure carry the SAME shape — per CLAUDE.md, client/server payload contracts belong in
/// Narya.Core and are never duplicated between a controller and the layer beneath it.
/// </para>
/// </summary>
public sealed record ActionTriggerReference(Guid Id, string Name, AutomationTriggerKind Kind)
{
  /// <summary>
  /// Projects a trigger down to a reference, deriving <see cref="Name"/> from the trigger's
  /// configuration. <see cref="AutomationTrigger"/> has no name field of its own (legacy had none
  /// either), so the operator-recognizable identity of a trigger is whatever they typed into its
  /// config — the phrase, the <c>!command</c>, the reward id, the manual label. A config whose
  /// identifying field is blank falls back to the kind name, so the reference is never an empty
  /// string in the 409 body.
  /// </summary>
  public static ActionTriggerReference From(AutomationTrigger trigger) =>
    new(trigger.Id, DescribeConfig(trigger.Config) ?? trigger.Kind.ToString(), trigger.Kind);

  private static string? DescribeConfig(TriggerConfig config) => config switch
  {
    RewardTriggerConfig reward => NullIfBlank(reward.RewardId, "Reward {0}"),
    TwitchEventTriggerConfig twitchEvent => twitchEvent.EventKind?.ToString(),
    ChatPhraseTriggerConfig phrase => NullIfBlank(phrase.Phrase, "{0}"),
    ViewerCommandTriggerConfig viewerCommand => NullIfBlank(viewerCommand.Command, "!{0}"),
    DashboardSlashTriggerConfig slash => NullIfBlank(slash.Command, "/{0}"),
    ManualTriggerConfig manual => NullIfBlank(manual.Label, "{0}"),
    _ => null,
  };

  private static string? NullIfBlank(string value, string format) =>
    string.IsNullOrWhiteSpace(value) ? null : string.Format(System.Globalization.CultureInfo.InvariantCulture, format, value);
}

/// <summary>
/// Marks a <see cref="Result{TValue}"/> failure from <see cref="IActionStore.DeleteAsync"/> as
/// "refused because triggers still reference this action" — the same typed-error pattern as
/// <see cref="DuplicateActionNameError"/>, so <c>Narya.Api.Controllers.ActionsController</c> maps
/// it to 409 by checking <c>result.HasError&lt;ActionInUseError&gt;()</c> rather than
/// string-matching a message.
///
/// <para>
/// Legacy CASCADED this relationship (<c>legacy/src/server/db.ts:397</c>), silently destroying
/// operator-authored trigger configuration — phrase text, reward id, cooldown settings — with no
/// warning. This codebase refuses the delete instead and hands back the blocking triggers so the
/// operator can repoint or remove them deliberately.
/// </para>
/// </summary>
public sealed class ActionInUseError(string actionName, IReadOnlyList<ActionTriggerReference> triggers)
  : Error($"\"{actionName}\" is still used by {triggers.Count} trigger(s). Repoint or delete them first.")
{
  /// <summary>The triggers blocking the delete, in creation order.</summary>
  public IReadOnlyList<ActionTriggerReference> Triggers { get; } = triggers;
}
