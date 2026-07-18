using FluentResults;

namespace Narya.Core.Actions;

/// <summary>
/// Marks a <see cref="Result{TValue}"/> failure as a case-insensitive name collision (legacy's
/// <c>isUniqueNameError</c>) rather than a generic validation rejection, so
/// <c>Narya.Api.Controllers.ActionsController</c> can return 409 instead of 400 by checking
/// <c>result.HasError&lt;DuplicateActionNameError&gt;()</c> instead of string-matching the error
/// message the way legacy's substring check on <c>error.message.toLowerCase().includes('unique')</c>
/// did.
/// </summary>
public sealed class DuplicateActionNameError(string name) : Error($"An action named \"{name}\" already exists.");

/// <summary>
/// The Action repository — named-and-reusable, ordered-step automations. A port of legacy's
/// <c>actions.ts</c> store half (the route half is <c>Narya.Api.Controllers.ActionsController</c>).
/// Implemented by <c>Narya.Database.Actions.ActionStore</c>; registered
/// <c>AddSingleton&lt;IActionStore, ActionStore&gt;</c> in
/// <c>Narya.Database.ServiceCollectionExtensions.AddNaryaDatabase</c> — same reference-direction
/// constraint as <c>Narya.Core.Media.IMediaAssetStore</c> (defined here, not alongside its
/// implementation, so a Narya.Core-only consumer — e.g. Phase 4 Task 3's executor — never needs to
/// reference Narya.Database).
/// </summary>
public interface IActionStore
{
  /// <summary>Every configured Action, ordered by <see cref="AutomationAction.Name"/> (case-insensitive).</summary>
  Task<IReadOnlyList<AutomationAction>> GetAllAsync(CancellationToken cancellationToken);

  /// <summary>The stored Action for <paramref name="id"/>, or <see langword="null"/> if none exists.</summary>
  Task<AutomationAction?> GetByIdAsync(Guid id, CancellationToken cancellationToken);

  /// <summary>
  /// Validates <paramref name="upsert"/> (via <see cref="ActionValidation.Normalize"/>) and
  /// inserts it. A validation failure never persists anything. Fails with
  /// <see cref="DuplicateActionNameError"/> if <see cref="ActionUpsert.Name"/> collides
  /// case-insensitively with an existing Action (the caller 409s); any other failure is a plain
  /// validation rejection (the caller 400s).
  /// </summary>
  Task<Result<AutomationAction>> CreateAsync(ActionUpsert upsert, CancellationToken cancellationToken);

  /// <summary>
  /// Loads <paramref name="id"/>, validates <paramref name="upsert"/> (a full replace — see
  /// <see cref="ActionUpsert"/>'s doc comment), and saves, REPLACING the whole
  /// <see cref="AutomationAction.Steps"/> list (Marten stores the embedded list; there is no
  /// per-step PATCH — matches legacy's delete-all-reinsert <c>saveSteps</c>). Returns
  /// <see langword="null"/> for an unknown <paramref name="id"/> (the caller 404s); otherwise a
  /// <see cref="Result{TValue}"/> following the same 400/409 split as <see cref="CreateAsync"/>.
  /// </summary>
  Task<Result<AutomationAction>?> UpdateAsync(Guid id, ActionUpsert upsert, CancellationToken cancellationToken);

  /// <summary>
  /// Hard-deletes <paramref name="id"/> and its embedded steps, REFUSING the delete while any
  /// <c>Narya.Core.Automation.AutomationTrigger</c> still references it.
  ///
  /// <para>
  /// Three outcomes, all expected — none of them exceptional:
  /// <list type="bullet">
  ///   <item><c>Ok(false)</c> — no such Action (the caller 404s).</item>
  ///   <item><c>Ok(true)</c> — deleted.</item>
  ///   <item>
  ///     Failed with <see cref="ActionInUseError"/> — one or more triggers reference it, and the
  ///     error carries them (id, name, kind) so the caller can 409 with the list and the operator
  ///     can repoint or delete them first. Nothing is written.
  ///   </item>
  /// </list>
  /// Disabled triggers count: a disabled trigger is still operator-authored configuration that can
  /// be re-enabled later, and silently orphaning it is exactly the loss this refusal prevents.
  /// Legacy instead CASCADED (<c>legacy/src/server/db.ts:397</c>) — see
  /// <see cref="ActionInUseError"/> for why this codebase does not.
  /// </para>
  ///
  /// <para>
  /// The reference check and the delete are atomic with respect to a trigger being created or
  /// repointed concurrently — see <c>Narya.Database.Actions.ActionStore.DeleteAsync</c> for the
  /// mechanism.
  /// </para>
  /// </summary>
  Task<Result<bool>> DeleteAsync(Guid id, CancellationToken cancellationToken);
}
