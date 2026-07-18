namespace Narya.Core.Actions;

/// <summary>
/// The outcome of a whole <see cref="AutomationAction"/> invocation — a port of legacy's
/// <c>ActionRunStatus</c> (<c>legacy/src/shared/api.ts:805</c>). <c>Partial</c> means at least one
/// step ran and at least one failed. <c>Skipped</c> means nothing ran (the Action was missing or
/// disabled, every step was disabled, or every step that did run itself skipped — e.g. every
/// referenced media asset was unavailable) — a <c>Skipped</c> run broadcasts nothing. Serialized as
/// a lowercase JSON string via the global <c>JsonStringEnumConverter(JsonNamingPolicy.CamelCase)</c>
/// registered in <c>Narya.Api.Program</c>.
/// </summary>
public enum ActionRunStatus
{
  Succeeded = 0,
  Partial = 1,
  Failed = 2,
  Skipped = 3,
}

/// <summary>
/// The outcome of a single <see cref="ActionStep"/> — a port of legacy's per-step half of
/// <c>ActionStepResult['status']</c> (<c>legacy/src/shared/api.ts:807-813</c>). Unlike
/// <see cref="ActionRunStatus"/> there is no <c>Partial</c> value here — a single step either ran
/// to completion, failed, or was skipped before it ran.
/// </summary>
public enum ActionStepStatus
{
  Succeeded = 0,
  Failed = 1,
  Skipped = 2,
}

/// <summary>
/// A single step's result within an <see cref="ActionRunResult"/> — a port of legacy's
/// <c>ActionStepResult</c>. <c>Type</c> is the same lowercase-snake-case discriminator string
/// <see cref="ActionStepJsonConverter"/> uses on the wire (<c>"show_text"</c>, <c>"play_media"</c>,
/// ...), not the C# step record's type name — see
/// <c>Narya.Application.Actions.ActionExecutor</c>'s <c>StepTypeName</c>. <c>Detail</c> is empty on
/// success; it carries why a step was skipped or the error message on failure.
/// </summary>
public sealed record ActionStepResult(Guid StepId, string Type, ActionStepStatus Status, string Detail);

/// <summary>
/// The result of running an <see cref="AutomationAction"/> once — a port of legacy's
/// <c>ActionRunResult</c>, returned by <c>Narya.Application.Actions.IActionExecutor.RunActionAsync</c>
/// and the <c>POST /api/actions/{id}/run</c> response body.
/// </summary>
public sealed record ActionRunResult(Guid ActionId, ActionRunStatus Status, IReadOnlyList<ActionStepResult> Steps, DateTimeOffset RanAt);
