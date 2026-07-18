using Narya.Core.Actions;

namespace Narya.Core.Automation;

/// <summary>
/// The <c>automation_runs</c> invocation log — a port of legacy's dedicated prepared statements in
/// <c>legacy/src/server/triggerDispatcher.ts</c> (<c>insertRun</c>/<c>finishRun</c>/<c>lastRunAt</c>/
/// <c>lastUserRunAt</c>/<c>deleteOldRuns</c>). This table is BOTH the invocation log and the dedupe
/// table AND the cooldown table: <see cref="TryClaimAsync"/> is the only write path that creates a
/// row, and the row it creates is what a later <see cref="TryClaimAsync"/> reads back to decide
/// whether the trigger is still cooling down. Implemented by <c>Narya.Database.Automation.AutomationRunStore</c>; registered
/// <c>AddSingleton&lt;IAutomationRunStore, AutomationRunStore&gt;</c> in
/// <c>Narya.Database.ServiceCollectionExtensions.AddNaryaDatabase</c> — same reference-direction
/// constraint as <c>Narya.Core.Automation.IAutomationTriggerStore</c> (defined here, not alongside
/// its implementation, so <c>Narya.Application.Automation.TriggerDispatcher</c> never needs to
/// reference Narya.Database).
/// </summary>
public interface IAutomationRunStore
{
  /// <summary>
  /// Inserts a PROVISIONAL run row (status <see cref="ActionRunStatus.Failed"/>, detail
  /// "Invocation did not complete.") BEFORE the caller runs the Action, and returns whether the
  /// insert won. <paramref name="dedupeKey"/> is <c>"{triggerId}:{eventId}"</c> when the invocation
  /// has a source event id, or <see langword="null"/> for a manual/module-lifecycle run that has
  /// none — a <see langword="null"/> key is exempt from the uniqueness constraint (Postgres treats
  /// every <c>NULL</c> as distinct, and the partial unique index only covers non-null values
  /// anyway), so two null-keyed claims always both succeed.
  ///
  /// <para>
  /// <b>This is the dedupe mechanism — never check-then-insert.</b> The insert either succeeds
  /// (this call returns <see langword="true"/> — the caller has exclusively claimed this
  /// <paramref name="dedupeKey"/> and must now run the Action) or violates the partial unique index
  /// on <c>DedupeKey</c> (this call returns <see langword="false"/> — a redelivery of the same
  /// source event for the same trigger, the caller must NOT run the Action again). A prior
  /// check-then-insert would have a TOCTOU gap two concurrent redeliveries could both pass; only the
  /// database's own uniqueness guarantee, observed via which insert wins, closes it.
  /// </para>
  ///
  /// <para>
  /// <b>This is also the cooldown gate.</b> <paramref name="cooldowns"/> is enforced HERE rather
  /// than by the caller, because a caller that reads the last run and then claims has a TOCTOU gap
  /// the dedupe key cannot close: two DIFFERENT event ids inside one cooldown window carry
  /// different dedupe keys, so both inserts are legal and both callers fire. When
  /// <see cref="TriggerCooldowns.Enforced"/>, the implementation must make the cooldown read and
  /// this insert one serialized operation, so exactly one of N racing callers is admitted.
  /// A cooldown rejection and a dedupe rejection are indistinguishable to the caller — both are
  /// <see langword="false"/>, both mean "do not run the Action."
  /// </para>
  /// </summary>
  Task<bool> TryClaimAsync(
    Guid runId,
    Guid triggerId,
    string? dedupeKey,
    string? actorLogin,
    DateTimeOffset ranAt,
    TriggerCooldowns cooldowns,
    CancellationToken cancellationToken);

  /// <summary>
  /// Updates the provisional row <paramref name="runId"/> claimed with the Action's real outcome.
  /// A no-op if <paramref name="runId"/> somehow does not exist (never expected in practice — every
  /// caller finishes a run it just claimed) rather than throwing, mirroring legacy's blind
  /// <c>UPDATE ... WHERE id = ?</c>, which likewise updates zero rows rather than erroring.
  /// </summary>
  Task FinishAsync(Guid runId, ActionRunStatus status, string detail, CancellationToken cancellationToken);

  /// <summary>
  /// Deletes every run row with <c>RanAt</c> before <paramref name="cutoff"/> and returns how many
  /// were removed. Called by <c>Narya.Api.Automation.AutomationRunPruneService</c> at boot and every
  /// 24h with a 7-day cutoff — see that type's doc comment for why the retention window must
  /// comfortably exceed both the longest configurable cooldown and any realistic EventSub
  /// redelivery gap.
  /// </summary>
  Task<int> PruneAsync(DateTimeOffset cutoff, CancellationToken cancellationToken);
}
