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

  /// <summary>
  /// The <c>classid</c> half of every Postgres advisory lock this store takes — a fixed Narya
  /// namespace (ASCII "NARY"), so a cooldown gate can never collide with an advisory lock some
  /// other component or extension takes in the same database.
  /// </summary>
  private const int AdvisoryLockNamespace = 0x4E415259;

  /// <summary>
  /// <b>Mechanism: a per-trigger Postgres advisory lock around the cooldown read AND the claim
  /// insert</b>, rather than the partial unique index that handles dedupe or the optimistic
  /// concurrency <c>AutomodStore</c> uses. Neither of those can express this constraint: the
  /// unique index keys on the dedupe key, and two DIFFERENT events inside one cooldown window
  /// carry two different dedupe keys, so both inserts are legal; optimistic concurrency guards one
  /// document's version, and here there is no shared document to version — the contended resource
  /// is "the most recent run row for this trigger", which the second caller is trying to CREATE.
  /// Serializing claimants per trigger is the only thing that makes the cooldown read reflect a
  /// concurrent claim that has already committed.
  ///
  /// <para>
  /// The lock is taken on its own connection, held across the read and the insert, and released
  /// only after the insert has committed — so the next claimant's read cannot miss it. It is
  /// skipped entirely when no cooldown is configured (<see cref="TriggerCooldowns.Enforced"/>),
  /// which is the common case: without a cooldown there is nothing to serialize, and the dedupe
  /// index alone is the gate.
  /// </para>
  /// </summary>
  public async Task<bool> TryClaimAsync(
    Guid runId,
    Guid triggerId,
    string? dedupeKey,
    string? actorLogin,
    DateTimeOffset ranAt,
    TriggerCooldowns cooldowns,
    CancellationToken cancellationToken)
  {
    if (!cooldowns.Enforced)
    {
      return await InsertClaimAsync(runId, triggerId, dedupeKey, actorLogin, ranAt, cancellationToken).ConfigureAwait(false);
    }

    var lockKey = AdvisoryLockKey(triggerId);
    await using var connection = store.Storage.Database.CreateConnection();
    await connection.OpenAsync(cancellationToken).ConfigureAwait(false);
    await ExecuteAdvisoryLockAsync(connection, "pg_advisory_lock", lockKey, cancellationToken).ConfigureAwait(false);

    try
    {
      return !await IsOnCooldownAsync(triggerId, actorLogin, ranAt, cooldowns, cancellationToken).ConfigureAwait(false)
        && await InsertClaimAsync(runId, triggerId, dedupeKey, actorLogin, ranAt, cancellationToken).ConfigureAwait(false);
    }
    finally
    {
      // Explicit, rather than relying on the connection going back to the pool: an advisory lock
      // belongs to the backend session, and a POOLED connection's backend outlives Dispose. Npgsql
      // does issue DISCARD ALL (which releases advisory locks) on reset, but a gate this important
      // should not depend on another library's reset policy staying the same.
      await ExecuteAdvisoryLockAsync(connection, "pg_advisory_unlock", lockKey, CancellationToken.None).ConfigureAwait(false);
    }
  }

  private async Task<bool> InsertClaimAsync(
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

  private async Task<bool> IsOnCooldownAsync(
    Guid triggerId, string? actorLogin, DateTimeOffset at, TriggerCooldowns cooldowns, CancellationToken cancellationToken)
  {
    await using var session = store.QuerySession();

    if (cooldowns.GlobalCooldownMs > 0)
    {
      var cutoff = at.AddMilliseconds(-cooldowns.GlobalCooldownMs);
      var blocked = await session.Query<AutomationRunDocument>()
        .AnyAsync(r => r.TriggerId == triggerId && r.RanAt > cutoff, cancellationToken)
        .ConfigureAwait(false);
      if (blocked)
      {
        return true;
      }
    }

    if (cooldowns.UserCooldownMs > 0 && !string.IsNullOrEmpty(actorLogin))
    {
      var cutoff = at.AddMilliseconds(-cooldowns.UserCooldownMs);
      var blocked = await session.Query<AutomationRunDocument>()
        .AnyAsync(r => r.TriggerId == triggerId && r.ActorLogin == actorLogin && r.RanAt > cutoff, cancellationToken)
        .ConfigureAwait(false);
      if (blocked)
      {
        return true;
      }
    }

    return false;
  }

  private static async Task ExecuteAdvisoryLockAsync(
    NpgsqlConnection connection, string function, int key, CancellationToken cancellationToken)
  {
    await using var command = connection.CreateCommand();
    command.CommandText = $"select {function}($1, $2)";
    _ = command.Parameters.Add(new NpgsqlParameter<int> { Value = AdvisoryLockNamespace });
    _ = command.Parameters.Add(new NpgsqlParameter<int> { Value = key });
    _ = await command.ExecuteScalarAsync(cancellationToken).ConfigureAwait(false);
  }

  /// <summary>
  /// Folds a trigger id down to the 32 bits an advisory lock's <c>objid</c> gets. A collision
  /// between two different triggers costs nothing but a little needless serialization between
  /// them — it can never admit a claim that should have been rejected, because both colliding
  /// callers still read and write their OWN trigger's rows under the shared lock.
  /// </summary>
  private static int AdvisoryLockKey(Guid triggerId)
  {
    Span<byte> bytes = stackalloc byte[16];
    _ = triggerId.TryWriteBytes(bytes);

    var key = 0;
    for (var offset = 0; offset < bytes.Length; offset += sizeof(int))
    {
      key ^= BitConverter.ToInt32(bytes[offset..(offset + sizeof(int))]);
    }

    return key;
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
