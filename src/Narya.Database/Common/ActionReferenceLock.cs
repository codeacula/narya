using Npgsql;

namespace Narya.Database.Common;

/// <summary>
/// The serialization point that keeps "an Action may not be deleted while a trigger references it"
/// true under concurrency.
///
/// <para>
/// <b>Mechanism: a per-ACTION transaction-scoped Postgres advisory lock</b>, the same idiom (and
/// the same reasoning) as <c>Narya.Database.Automation.AutomationRunStore</c>'s per-trigger
/// cooldown lock. Two writers contend here across two DIFFERENT document types:
/// <c>ActionStore.DeleteAsync</c> reads the trigger table and then deletes an action row, while
/// <c>AutomationTriggerStore.CreateAsync</c>/<c>UpdateAsync</c> read that action row and then write
/// a trigger row. Neither a unique index (there is no single row whose uniqueness expresses the
/// constraint) nor optimistic concurrency (the action document is not modified by the trigger
/// write, so its version never moves) can see that interleaving; without the lock, under READ
/// COMMITTED both transactions read a world in which the other's write does not exist yet and both
/// commit, leaving an orphaned trigger.
/// </para>
///
/// <para>
/// Both sides take the lock on the SINGLE pooled connection that also carries their reads and
/// writes, before the first read, and hold it until COMMIT/ROLLBACK ends the transaction — so a
/// waiter's read always reflects the holder's committed outcome, and no path can leak a held lock
/// or need a second connection while holding one (see <c>AutomationRunStore.TryClaimAsync</c> on
/// why the second connection would invert the pool).
/// </para>
/// </summary>
internal static class ActionReferenceLock
{
  /// <summary>
  /// The <c>classid</c> half of this lock — a fixed Narya namespace (ASCII "NARA"), distinct from
  /// <c>AutomationRunStore</c>'s cooldown namespace so an action-reference lock and a cooldown
  /// lock can never contend with each other by accident.
  /// </summary>
  private const int LockNamespace = 0x4E415241;

  /// <summary>
  /// Takes the lock for <paramref name="actionId"/> on <paramref name="transaction"/>'s connection.
  /// Released by the transaction's COMMIT or ROLLBACK — there is no unlock call a failure path
  /// could skip.
  /// </summary>
  public static async Task TakeAsync(NpgsqlTransaction transaction, Guid actionId, CancellationToken cancellationToken)
  {
    await using var command = transaction.Connection!.CreateCommand();
    command.Transaction = transaction;
    command.CommandText = "select pg_advisory_xact_lock($1, $2)";
    _ = command.Parameters.Add(new NpgsqlParameter<int> { Value = LockNamespace });
    _ = command.Parameters.Add(new NpgsqlParameter<int> { Value = LockKey(actionId) });
    _ = await command.ExecuteScalarAsync(cancellationToken).ConfigureAwait(false);
  }

  /// <summary>
  /// Folds an action id down to the 32 bits an advisory lock's <c>objid</c> gets. A collision
  /// between two different actions costs nothing but a little needless serialization between two
  /// rare operator-initiated writes — it can never admit a write that should have been refused,
  /// since both colliding callers still read and write their OWN action's rows under the shared
  /// lock.
  /// </summary>
  private static int LockKey(Guid actionId)
  {
    Span<byte> bytes = stackalloc byte[16];
    _ = actionId.TryWriteBytes(bytes);

    var key = 0;
    for (var offset = 0; offset < bytes.Length; offset += sizeof(int))
    {
      key ^= BitConverter.ToInt32(bytes[offset..]);
    }

    return key;
  }
}
