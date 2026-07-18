using FluentResults;

namespace Narya.Core.Automation;

/// <summary>
/// The automation trigger repository — typed sources (reward, Twitch event, chat phrase, viewer
/// <c>!command</c>, dashboard <c>/command</c>, manual, module lifecycle) that fire a
/// <c>Narya.Core.Actions.AutomationAction</c>. A port of legacy's <c>automationTriggers.ts</c> store
/// half (the route half is <c>Narya.Api.Controllers.AutomationTriggersController</c>; the matching/
/// cooldown/dedup half is Phase 4 Task 6's <c>ITriggerDispatcher</c>). Implemented by
/// <c>Narya.Database.Automation.AutomationTriggerStore</c>; registered
/// <c>AddSingleton&lt;IAutomationTriggerStore, AutomationTriggerStore&gt;</c> in
/// <c>Narya.Database.ServiceCollectionExtensions.AddNaryaDatabase</c> — same reference-direction
/// constraint as <c>Narya.Core.Actions.IActionStore</c> (defined here, not alongside its
/// implementation, so a Narya.Core-only consumer — e.g. Phase 4 Task 6's dispatcher — never needs to
/// reference Narya.Database).
/// </summary>
public interface IAutomationTriggerStore
{
  /// <summary>Every configured trigger, ordered by <see cref="AutomationTrigger.CreatedAt"/>.</summary>
  Task<IReadOnlyList<AutomationTrigger>> GetAllAsync(CancellationToken cancellationToken);

  /// <summary>The stored trigger for <paramref name="id"/>, or <see langword="null"/> if none exists.</summary>
  Task<AutomationTrigger?> GetByIdAsync(Guid id, CancellationToken cancellationToken);

  /// <summary>
  /// The dispatcher's (Phase 4 Task 6) read path: only enabled triggers of one kind, in creation
  /// order — a port of legacy's <c>listEnabledTriggersOfKind</c>.
  /// </summary>
  Task<IReadOnlyList<AutomationTrigger>> GetEnabledByKindAsync(AutomationTriggerKind kind, CancellationToken cancellationToken);

  /// <summary>
  /// Every trigger — enabled OR DISABLED — that fires the Action <paramref name="actionId"/>, in
  /// creation order. This is the referential-integrity read behind
  /// <c>Narya.Core.Actions.IActionStore.DeleteAsync</c>'s refusal: a disabled trigger still counts,
  /// because it is configuration the operator can re-enable and would otherwise lose track of.
  /// </summary>
  Task<IReadOnlyList<AutomationTrigger>> GetByActionIdAsync(Guid actionId, CancellationToken cancellationToken);

  /// <summary>
  /// Validates <paramref name="upsert"/> (via <see cref="AutomationTriggerValidation.Normalize"/>,
  /// then confirms <see cref="AutomationTriggerUpsert.ActionId"/> exists) and inserts it. A
  /// validation failure never persists anything. Every failure here is a plain validation
  /// rejection (the caller 400s) — unlike <c>Narya.Core.Actions.IActionStore.CreateAsync</c>, there
  /// is no typed "conflict" case to distinguish.
  /// </summary>
  Task<Result<AutomationTrigger>> CreateAsync(AutomationTriggerUpsert upsert, CancellationToken cancellationToken);

  /// <summary>
  /// Loads <paramref name="id"/>, validates <paramref name="upsert"/> (a full replace), and saves.
  /// Returns <see langword="null"/> for an unknown <paramref name="id"/> (the caller 404s);
  /// otherwise a <see cref="Result{TValue}"/> the caller 400s on failure.
  /// </summary>
  Task<Result<AutomationTrigger>?> UpdateAsync(Guid id, AutomationTriggerUpsert upsert, CancellationToken cancellationToken);

  /// <summary>Hard-deletes <paramref name="id"/>. Returns <see langword="false"/> for an unknown id (the caller 404s), <see langword="true"/> otherwise.</summary>
  Task<bool> DeleteAsync(Guid id, CancellationToken cancellationToken);
}
