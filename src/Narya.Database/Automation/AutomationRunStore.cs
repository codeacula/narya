using Marten;

using Narya.Core.Actions;
using Narya.Core.Automation;

using Npgsql;

namespace Narya.Database.Automation;

/// <summary>
/// <see cref="IAutomationRunStore"/> backed by the plain (non-event-sourced)
/// <see cref="AutomationRunDocument"/> — mirrors legacy's dedicated prepared statements in
/// <c>legacy/src/server/triggerDispatcher.ts</c>.
/// </summary>
public sealed class AutomationRunStore(IDocumentStore store) : IAutomationRunStore
{
  /// <summary>
  /// The provisional row's status/detail — see <see cref="TryClaimAsync"/>'s doc comment on
  /// <see cref="IAutomationRunStore.TryClaimAsync"/> for why <see cref="ActionRunStatus.Failed"/>
  /// (not some neutral "pending" value) is the honest provisional status: if the process dies
  /// mid-invocation, the log keeps the truthful record that the run never completed, rather than
  /// claiming success.
  /// </summary>
  private const string ProvisionalDetail = "Invocation did not complete.";

  public async Task<bool> TryClaimAsync(
    Guid runId, Guid triggerId, string? dedupeKey, string? actorLogin, DateTimeOffset ranAt, CancellationToken cancellationToken)
  {
    await using var session = store.LightweightSession();
    session.Insert(new AutomationRunDocument
    {
      Id = runId,
      TriggerId = triggerId,
      DedupeKey = dedupeKey,
      ActorLogin = actorLogin,
      Status = ActionRunStatus.Failed,
      Detail = ProvisionalDetail,
      RanAt = ranAt,
    });

    try
    {
      await session.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
      return true;
    }
    catch (Exception ex) when (IsUniqueViolation(ex))
    {
      return false;
    }
  }

  public async Task FinishAsync(Guid runId, ActionRunStatus status, string detail, CancellationToken cancellationToken)
  {
    await using var session = store.LightweightSession();
    var existing = await session.LoadAsync<AutomationRunDocument>(runId, cancellationToken).ConfigureAwait(false);
    if (existing is null)
    {
      return;
    }

    session.Store(existing with { Status = status, Detail = detail });
    await session.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
  }

  public async Task<DateTimeOffset?> GetLastRunAtAsync(Guid triggerId, CancellationToken cancellationToken)
  {
    await using var session = store.QuerySession();
    var last = await session.Query<AutomationRunDocument>()
      .Where(r => r.TriggerId == triggerId)
      .OrderByDescending(r => r.RanAt)
      .FirstOrDefaultAsync(cancellationToken)
      .ConfigureAwait(false);
    return last?.RanAt;
  }

  public async Task<DateTimeOffset?> GetLastUserRunAtAsync(Guid triggerId, string actorLogin, CancellationToken cancellationToken)
  {
    await using var session = store.QuerySession();
    var last = await session.Query<AutomationRunDocument>()
      .Where(r => r.TriggerId == triggerId && r.ActorLogin == actorLogin)
      .OrderByDescending(r => r.RanAt)
      .FirstOrDefaultAsync(cancellationToken)
      .ConfigureAwait(false);
    return last?.RanAt;
  }

  public async Task<int> PruneAsync(DateTimeOffset cutoff, CancellationToken cancellationToken)
  {
    await using var session = store.LightweightSession();
    var count = await session.Query<AutomationRunDocument>()
      .CountAsync(r => r.RanAt < cutoff, cancellationToken)
      .ConfigureAwait(false);
    if (count == 0)
    {
      return 0;
    }

    session.DeleteWhere<AutomationRunDocument>(r => r.RanAt < cutoff);
    await session.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
    return count;
  }

  /// <summary>
  /// Walks the exception chain (Marten wraps the underlying Postgres failure in
  /// <c>MartenCommandException</c>) looking for Postgres SQLSTATE 23505 (unique_violation) — the
  /// partial unique index on <see cref="AutomationRunDocument.DedupeKey"/> rejecting a redelivered
  /// event's second claim. Identical pattern to
  /// <c>Narya.Database.Actions.ActionStore.IsUniqueNameViolation</c>.
  /// </summary>
  private static bool IsUniqueViolation(Exception error)
  {
    for (var current = error; current is not null; current = current.InnerException)
    {
      if (current is PostgresException { SqlState: PostgresErrorCodes.UniqueViolation })
      {
        return true;
      }
    }

    return false;
  }
}
