using Marten;
using Marten.Services;

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
  /// <b>Exactly ONE pooled connection is used for the whole claim</b>, and the lock is taken on it:
  /// the transaction-scoped <c>pg_advisory_xact_lock</c>, the cooldown read and the claim insert all
  /// run on that single connection, inside one transaction. Taking the lock on a connection separate
  /// from the read and the insert would invert the pool — every waiter would hold a connection it
  /// cannot use while the one lock holder still needed two MORE connections from the same pool
  /// before it could release. A burst of concurrent claims on one trigger (a raid, or a spam wave
  /// driving one chat-phrase trigger) would exhaust Npgsql's pool with lock waiters, stall the
  /// holder until the connection timeout, and fail every claim in the burst with an exception rather
  /// than a true/false verdict.
  /// </para>
  ///
  /// <para>
  /// The lock is transaction-scoped, so it is released by the COMMIT itself — the claim row is
  /// visible to the next waiter the instant the lock is, with no window in between and no unlock
  /// statement that a failure path could skip. It is skipped entirely when no cooldown is configured
  /// (<see cref="TriggerCooldowns.Enforced"/>), which is the common case: without a cooldown there
  /// is nothing to serialize, and the dedupe index alone is the gate.
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
      await using var unlockedSession = store.LightweightSession();
      return await InsertClaimAsync(unlockedSession, runId, triggerId, dedupeKey, actorLogin, ranAt, cancellationToken)
        .ConfigureAwait(false);
    }

    // ONE pooled connection for the whole claim: the lock, the cooldown read and the insert all run
    // on it, inside one transaction. SessionOptions.ForTransaction enlists Marten in the
    // externally-owned transaction, so the session borrows THIS connection instead of renting a
    // second one, and leaves the commit to us.
    //
    // READ COMMITTED is passed EXPLICITLY, not inherited. The whole gate depends on the cooldown
    // read seeing the winner's just-committed claim row, and only READ COMMITTED takes a fresh
    // snapshot per statement — the read runs AFTER pg_advisory_xact_lock returns, so it sees
    // everything the previous holder committed on its way out. Under REPEATABLE READ or
    // SERIALIZABLE the transaction is instead pinned to a snapshot taken at its FIRST statement,
    // which is the lock acquisition itself: every waiter would then read a snapshot from before
    // the winner committed, miss the claim row, and insert its own — silently reopening the exact
    // TOCTOU this lock exists to close, on any deployment whose
    // default_transaction_isolation is hardened away from the Postgres default.
    await using var connection = store.Storage.Database.CreateConnection();
    await connection.OpenAsync(cancellationToken).ConfigureAwait(false);
    await using var transaction = await connection
      .BeginTransactionAsync(System.Data.IsolationLevel.ReadCommitted, cancellationToken)
      .ConfigureAwait(false);
    await TakeAdvisoryLockAsync(transaction, AdvisoryLockKey(triggerId), cancellationToken).ConfigureAwait(false);

    await using var session = store.LightweightSession(SessionOptions.ForTransaction(transaction));

    if (await IsOnCooldownAsync(session, triggerId, actorLogin, ranAt, cooldowns, cancellationToken).ConfigureAwait(false))
    {
      // Roll back rather than just returning: nothing was written, but the ROLLBACK is what ends the
      // transaction and so releases the advisory lock for the next waiter. Letting disposal do it
      // would hold the lock for the rest of this method's scope.
      await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
      return false;
    }

    if (!await InsertClaimAsync(session, runId, triggerId, dedupeKey, actorLogin, ranAt, cancellationToken).ConfigureAwait(false))
    {
      // The dedupe index rejected a redelivery. The failed statement has already aborted the
      // transaction; roll it back explicitly for the same reason as above.
      await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
      return false;
    }

    // COMMIT publishes the claim row and releases the transaction-scoped lock in one step, so the
    // next waiter's cooldown read cannot miss the row this caller just claimed.
    await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
    return true;
  }

  private static async Task<bool> InsertClaimAsync(
    IDocumentSession session,
    Guid runId, Guid triggerId, string? dedupeKey, string? actorLogin, DateTimeOffset ranAt, CancellationToken cancellationToken)
  {
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

  /// <summary>
  /// Reads through the CALLER's session — the one already enlisted in the advisory-locked
  /// transaction — rather than opening a session (and therefore a second pooled connection) of its
  /// own. See <see cref="TryClaimAsync"/> on why a second connection here would invert the pool.
  /// </summary>
  private static async Task<bool> IsOnCooldownAsync(
    IQuerySession session,
    Guid triggerId, string? actorLogin, DateTimeOffset at, TriggerCooldowns cooldowns, CancellationToken cancellationToken)
  {
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

  private static async Task TakeAdvisoryLockAsync(
    NpgsqlTransaction transaction, int key, CancellationToken cancellationToken)
  {
    await using var command = transaction.Connection!.CreateCommand();
    command.Transaction = transaction;
    command.CommandText = "select pg_advisory_xact_lock($1, $2)";
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
