using FluentResults;

using Marten;
using Marten.Services;

using Narya.Core.Automation;
using Narya.Database.Actions;
using Narya.Database.Common;

using Npgsql;

namespace Narya.Database.Automation;

/// <summary>
/// <see cref="IAutomationTriggerStore"/> backed by the plain (non-event-sourced)
/// <see cref="AutomationTriggerDocument"/> — mirrors legacy's <c>automationTriggers.ts</c> store
/// half.
///
/// <para>
/// <b>Field-shape validation lives in <see cref="AutomationTriggerValidation"/>, not here.</b> This
/// store adds the one check that needs I/O: <see cref="AutomationTriggerUpsert.ActionId"/> must
/// reference an existing <c>Narya.Core.Actions.AutomationAction</c>. That check is a raw load of
/// <c>Narya.Database.Actions.ActionDocument</c> rather than a call through
/// <c>Narya.Core.Actions.IActionStore</c> — deliberately, and reversing an earlier choice here: the
/// check and the trigger write must share ONE advisory-locked transaction (see
/// <see cref="Narya.Database.Common.ActionReferenceLock"/> and
/// <c>Narya.Database.Actions.ActionStore.DeleteAsync</c>), or a concurrent Action delete can slip
/// between them and orphan the trigger. Going through the port would open a second session on a
/// second connection outside that transaction, which is exactly the window being closed. Both types
/// live in Narya.Database, so nothing about the layering rules changes. A missing Action
/// fails with the plain string "Action not found." (the caller 400s), matching legacy's
/// <c>HttpRouteError(400, 'Action not found.')</c> — legacy also 400s a missing action rather than
/// 404ing, since the id lives inside the trigger BODY, not the route.
/// </para>
///
/// <para>
/// <see cref="AutomationTriggerUpsert.ModuleId"/> is intentionally NOT checked against anything —
/// see <see cref="AutomationTrigger"/>'s doc comment for why: Phase 8's <c>category_modules</c>
/// does not exist yet, and inventing a port that always returns <see langword="false"/> would
/// block every module-scoped trigger from ever being created, which is worse than accepting an
/// unvalidated id that simply does nothing until Phase 8 ships.
/// </para>
/// </summary>
public sealed class AutomationTriggerStore(IDocumentStore store, TimeProvider timeProvider) : IAutomationTriggerStore
{
  public async Task<IReadOnlyList<AutomationTrigger>> GetAllAsync(CancellationToken cancellationToken)
  {
    await using var session = store.QuerySession();
    var docs = await session.Query<AutomationTriggerDocument>().ToListAsync(cancellationToken).ConfigureAwait(false);
    return [.. docs.Select(ToTrigger).OrderBy(t => t.CreatedAt)];
  }

  public async Task<AutomationTrigger?> GetByIdAsync(Guid id, CancellationToken cancellationToken)
  {
    await using var session = store.QuerySession();
    var doc = await session.LoadAsync<AutomationTriggerDocument>(id, cancellationToken).ConfigureAwait(false);
    return doc is null ? null : ToTrigger(doc);
  }

  public async Task<IReadOnlyList<AutomationTrigger>> GetEnabledByKindAsync(AutomationTriggerKind kind, CancellationToken cancellationToken)
  {
    await using var session = store.QuerySession();
    var docs = await session.Query<AutomationTriggerDocument>()
      .Where(d => d.Kind == kind && d.Enabled)
      .ToListAsync(cancellationToken)
      .ConfigureAwait(false);
    return [.. docs.Select(ToTrigger).OrderBy(t => t.CreatedAt)];
  }

  /// <summary>
  /// The action-exists check and the insert run inside one advisory-locked transaction — see this
  /// type's doc comment and <see cref="Narya.Database.Common.ActionReferenceLock"/>.
  /// </summary>
  public async Task<Result<AutomationTrigger>> CreateAsync(AutomationTriggerUpsert upsert, CancellationToken cancellationToken)
  {
    var normalized = AutomationTriggerValidation.Normalize(upsert);
    if (normalized.IsFailed)
    {
      return Result.Fail<AutomationTrigger>(normalized.Errors);
    }

    var now = timeProvider.GetUtcNow();
    var doc = new AutomationTriggerDocument
    {
      Id = Guid.NewGuid(),
      Kind = normalized.Value.Kind,
      ActionId = normalized.Value.ActionId,
      ModuleId = normalized.Value.ModuleId,
      Enabled = normalized.Value.Enabled,
      Config = normalized.Value.Config,
      GlobalCooldownMs = normalized.Value.GlobalCooldownMs,
      UserCooldownMs = normalized.Value.UserCooldownMs,
      CreatedAt = now,
      UpdatedAt = now,
    };

    await using var scope = await LockedScope.OpenAsync(store, normalized.Value.ActionId, cancellationToken).ConfigureAwait(false);

    if (!await ActionExistsAsync(scope.Session, normalized.Value.ActionId, cancellationToken).ConfigureAwait(false))
    {
      await scope.RollbackAsync(cancellationToken).ConfigureAwait(false);
      return Result.Fail<AutomationTrigger>("Action not found.");
    }

    scope.Session.Insert(doc);
    await scope.CommitAsync(cancellationToken).ConfigureAwait(false);
    return Result.Ok(ToTrigger(doc));
  }

  /// <summary>
  /// Same locked scope as <see cref="CreateAsync"/>, keyed on the NEW
  /// <see cref="AutomationTriggerUpsert.ActionId"/> — the only one that can be orphaned by a
  /// concurrent delete. Dropping a reference to the OLD action needs no lock: removing a reference
  /// never creates an orphan.
  /// </summary>
  public async Task<Result<AutomationTrigger>?> UpdateAsync(Guid id, AutomationTriggerUpsert upsert, CancellationToken cancellationToken)
  {
    var normalized = AutomationTriggerValidation.Normalize(upsert);

    // The unknown-id 404 outranks a validation 400 (same load-then-branch order as before), so the
    // existence load happens first — but it must happen inside the locked transaction, which needs
    // the normalized ActionId as its key. A validation failure therefore takes the lock, loads, and
    // rolls back having written nothing.
    var lockKey = normalized.IsSuccess ? normalized.Value.ActionId : upsert.ActionId;
    await using var scope = await LockedScope.OpenAsync(store, lockKey, cancellationToken).ConfigureAwait(false);

    var existing = await scope.Session.LoadAsync<AutomationTriggerDocument>(id, cancellationToken).ConfigureAwait(false);
    if (existing is null)
    {
      await scope.RollbackAsync(cancellationToken).ConfigureAwait(false);
      return null;
    }

    if (normalized.IsFailed)
    {
      await scope.RollbackAsync(cancellationToken).ConfigureAwait(false);
      return Result.Fail<AutomationTrigger>(normalized.Errors);
    }

    if (!await ActionExistsAsync(scope.Session, normalized.Value.ActionId, cancellationToken).ConfigureAwait(false))
    {
      await scope.RollbackAsync(cancellationToken).ConfigureAwait(false);
      return Result.Fail<AutomationTrigger>("Action not found.");
    }

    var updated = existing with
    {
      Kind = normalized.Value.Kind,
      ActionId = normalized.Value.ActionId,
      ModuleId = normalized.Value.ModuleId,
      Enabled = normalized.Value.Enabled,
      Config = normalized.Value.Config,
      GlobalCooldownMs = normalized.Value.GlobalCooldownMs,
      UserCooldownMs = normalized.Value.UserCooldownMs,
      UpdatedAt = timeProvider.GetUtcNow(),
    };

    scope.Session.Store(updated);
    await scope.CommitAsync(cancellationToken).ConfigureAwait(false);
    return Result.Ok(ToTrigger(updated));
  }

  public async Task<bool> DeleteAsync(Guid id, CancellationToken cancellationToken)
  {
    await using var session = store.LightweightSession();
    var existing = await session.LoadAsync<AutomationTriggerDocument>(id, cancellationToken).ConfigureAwait(false);
    if (existing is null)
    {
      return false;
    }

    session.Delete<AutomationTriggerDocument>(id);
    await session.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
    return true;
  }

  private static async Task<bool> ActionExistsAsync(IQuerySession session, Guid actionId, CancellationToken cancellationToken) =>
    await session.LoadAsync<ActionDocument>(actionId, cancellationToken).ConfigureAwait(false) is not null;

  private static AutomationTrigger ToTrigger(AutomationTriggerDocument doc) => AutomationTriggerQueries.ToTrigger(doc);

  /// <summary>
  /// One pooled connection, one transaction, one <see cref="ActionReferenceLock"/> held for its
  /// lifetime, and a Marten session enlisted in it. Every exit path must call
  /// <see cref="CommitAsync"/> or <see cref="RollbackAsync"/> explicitly — disposal alone would
  /// roll back correctly, but only at the END of the caller's scope, holding the lock against every
  /// waiter for longer than necessary.
  /// </summary>
  private sealed class LockedScope : IAsyncDisposable
  {
    private readonly NpgsqlConnection connection;
    private readonly NpgsqlTransaction transaction;

    private LockedScope(NpgsqlConnection connection, NpgsqlTransaction transaction, IDocumentSession session)
    {
      this.connection = connection;
      this.transaction = transaction;
      Session = session;
    }

    public IDocumentSession Session { get; }

    public static async Task<LockedScope> OpenAsync(IDocumentStore store, Guid actionId, CancellationToken cancellationToken)
    {
      // Nothing owns the connection or the transaction until the LockedScope is constructed, so
      // every step between here and that constructor has to unwind them by hand. A throw from
      // OpenAsync/BeginTransactionAsync/TakeAsync (cancellation while blocked on
      // pg_advisory_xact_lock is the realistic one) would otherwise leave a pooled connection
      // stranded idle-in-transaction, still holding its lock, until finalization.
      NpgsqlConnection? connection = null;
      NpgsqlTransaction? transaction = null;
      try
      {
        connection = store.Storage.Database.CreateConnection();
        await connection.OpenAsync(cancellationToken).ConfigureAwait(false);
        // READ COMMITTED — the action-exists check inside this scope is only correct because it
        // takes a fresh snapshot AFTER the advisory lock was granted, and so sees a concurrent
        // delete that already committed. A pinned (REPEATABLE READ / SERIALIZABLE) snapshot taken
        // at lock acquisition would let this write a trigger against an action the delete already
        // removed. See ActionStore.DeleteAsync for the mirror image.
        //
        // Stated explicitly rather than relying on Npgsql's ReadCommitted default for
        // IsolationLevel.Unspecified. Npgsql does NOT inherit the server's
        // default_transaction_isolation, so this is defense against a future driver-default
        // change, not against a hardened server — see AutomationRunStore.TryClaimAsync.
        transaction = await connection
          .BeginTransactionAsync(System.Data.IsolationLevel.ReadCommitted, cancellationToken)
          .ConfigureAwait(false);
        await ActionReferenceLock.TakeAsync(transaction, actionId, cancellationToken).ConfigureAwait(false);

        // ForTransaction enlists Marten in the transaction we own: the session borrows THIS
        // connection instead of renting a second one, and leaves the commit to us.
        return new LockedScope(connection, transaction, store.LightweightSession(SessionOptions.ForTransaction(transaction)));
      }
      catch
      {
        if (transaction is not null)
        {
          await transaction.DisposeAsync().ConfigureAwait(false);
        }

        if (connection is not null)
        {
          await connection.DisposeAsync().ConfigureAwait(false);
        }

        throw;
      }
    }

    public async Task CommitAsync(CancellationToken cancellationToken)
    {
      await Session.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
      await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
    }

    public Task RollbackAsync(CancellationToken cancellationToken) => transaction.RollbackAsync(cancellationToken);

    public async ValueTask DisposeAsync()
    {
      await Session.DisposeAsync().ConfigureAwait(false);
      await transaction.DisposeAsync().ConfigureAwait(false);
      await connection.DisposeAsync().ConfigureAwait(false);
    }
  }
}
