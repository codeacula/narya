using Narya.Core.Actions;

namespace Narya.Core.Automation;

/// <summary>
/// The <c>automation_runs</c> invocation log — a port of legacy's dedicated prepared statements in
/// <c>legacy/src/server/triggerDispatcher.ts</c> (<c>insertRun</c>/<c>finishRun</c>/<c>lastRunAt</c>/
/// <c>lastUserRunAt</c>/<c>deleteOldRuns</c>). This table is BOTH the invocation log and the dedupe
/// table: <see cref="TryClaimAsync"/> is the only write path that creates a row, and the row it
/// creates is what <see cref="GetLastRunAtAsync"/>/<see cref="GetLastUserRunAtAsync"/> read back for
/// cooldowns. Implemented by <c>Narya.Database.Automation.AutomationRunStore</c>; registered
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
  /// </summary>
  Task<bool> TryClaimAsync(
    Guid runId, Guid triggerId, string? dedupeKey, string? actorLogin, DateTimeOffset ranAt, CancellationToken cancellationToken);

  /// <summary>
  /// Updates the provisional row <paramref name="runId"/> claimed with the Action's real outcome.
  /// A no-op if <paramref name="runId"/> somehow does not exist (never expected in practice — every
  /// caller finishes a run it just claimed) rather than throwing, mirroring legacy's blind
  /// <c>UPDATE ... WHERE id = ?</c>, which likewise updates zero rows rather than erroring.
  /// </summary>
  Task FinishAsync(Guid runId, ActionRunStatus status, string detail, CancellationToken cancellationToken);

  /// <summary>The most recent <c>RanAt</c> for any run of <paramref name="triggerId"/>, regardless of status — the global-cooldown source.</summary>
  Task<DateTimeOffset?> GetLastRunAtAsync(Guid triggerId, CancellationToken cancellationToken);

  /// <summary>The most recent <c>RanAt</c> for <paramref name="triggerId"/> and <paramref name="actorLogin"/>, regardless of status — the user-cooldown source.</summary>
  Task<DateTimeOffset?> GetLastUserRunAtAsync(Guid triggerId, string actorLogin, CancellationToken cancellationToken);

  /// <summary>
  /// Deletes every run row with <c>RanAt</c> before <paramref name="cutoff"/> and returns how many
  /// were removed. Called by <c>Narya.Api.Automation.AutomationRunPruneService</c> at boot and every
  /// 24h with a 7-day cutoff — see that type's doc comment for why the retention window must
  /// comfortably exceed both the longest configurable cooldown and any realistic EventSub
  /// redelivery gap.
  /// </summary>
  Task<int> PruneAsync(DateTimeOffset cutoff, CancellationToken cancellationToken);
}
