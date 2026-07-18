using FluentResults;

using Marten;
using Marten.Services;

using Narya.Core.Actions;
using Narya.Database.Automation;
using Narya.Database.Common;

using Npgsql;

namespace Narya.Database.Actions;

/// <summary>
/// <see cref="IActionStore"/> backed by the plain (non-event-sourced) <see cref="ActionDocument"/>
/// — mirrors legacy's <c>actions.ts</c>.
///
/// <para>
/// <b>Validation lives in <c>Narya.Core.Actions.ActionValidation</c>, not here.</b> This store's
/// job is: normalize, assign identity (id/timestamps/step id+position), persist, and translate the
/// database's case-insensitive unique-name violation into a typed
/// <see cref="DuplicateActionNameError"/> — mirroring
/// <c>Narya.Database.Media.MediaAssetStore</c>'s division of labor.
/// </para>
/// </summary>
public sealed class ActionStore(IDocumentStore store, TimeProvider timeProvider) : IActionStore
{
  public async Task<IReadOnlyList<AutomationAction>> GetAllAsync(CancellationToken cancellationToken)
  {
    await using var session = store.QuerySession();
    var docs = await session.Query<ActionDocument>().ToListAsync(cancellationToken);
    return [.. docs.Select(ToAction).OrderBy(a => a.Name, StringComparer.OrdinalIgnoreCase)];
  }

  public async Task<AutomationAction?> GetByIdAsync(Guid id, CancellationToken cancellationToken)
  {
    await using var session = store.QuerySession();
    var doc = await session.LoadAsync<ActionDocument>(id, cancellationToken);
    return doc is null ? null : ToAction(doc);
  }

  public async Task<Result<AutomationAction>> CreateAsync(ActionUpsert upsert, CancellationToken cancellationToken)
  {
    var normalized = ActionValidation.Normalize(upsert);
    if (normalized.IsFailed)
    {
      return Result.Fail<AutomationAction>(normalized.Errors);
    }

    var now = timeProvider.GetUtcNow();
    var doc = new ActionDocument
    {
      Id = Guid.NewGuid(),
      Name = normalized.Value.Name,
      Description = normalized.Value.Description,
      Enabled = normalized.Value.Enabled,
      QuickDisable = normalized.Value.QuickDisable,
      Steps = AssignStepIdentity(normalized.Value.Steps),
      CreatedAt = now,
      UpdatedAt = now,
    };

    await using var session = store.LightweightSession();
    session.Insert(doc);

    var saveResult = await TrySaveAsync(session, normalized.Value.Name, cancellationToken).ConfigureAwait(false);
    return saveResult.IsFailed ? Result.Fail<AutomationAction>(saveResult.Errors) : Result.Ok(ToAction(doc));
  }

  public async Task<Result<AutomationAction>?> UpdateAsync(Guid id, ActionUpsert upsert, CancellationToken cancellationToken)
  {
    await using var session = store.LightweightSession();
    var existing = await session.LoadAsync<ActionDocument>(id, cancellationToken);
    if (existing is null)
    {
      return null;
    }

    var normalized = ActionValidation.Normalize(upsert);
    if (normalized.IsFailed)
    {
      return Result.Fail<AutomationAction>(normalized.Errors);
    }

    var updated = existing with
    {
      Name = normalized.Value.Name,
      Description = normalized.Value.Description,
      Enabled = normalized.Value.Enabled,
      QuickDisable = normalized.Value.QuickDisable,
      Steps = AssignStepIdentity(normalized.Value.Steps),
      UpdatedAt = timeProvider.GetUtcNow(),
    };

    session.Store(updated);

    var saveResult = await TrySaveAsync(session, normalized.Value.Name, cancellationToken).ConfigureAwait(false);
    return saveResult.IsFailed ? Result.Fail<AutomationAction>(saveResult.Errors) : Result.Ok(ToAction(updated));
  }

  /// <summary>
  /// Refuses the delete while any trigger — enabled or disabled — still references the Action, and
  /// reports the blockers instead of cascading (see
  /// <see cref="Narya.Core.Actions.ActionInUseError"/>).
  ///
  /// <para>
  /// <b>Mechanism: the per-action advisory lock in
  /// <see cref="Narya.Database.Common.ActionReferenceLock"/></b>, taken before the reference read
  /// and released only by this transaction's COMMIT/ROLLBACK. The reference read, the existence
  /// load and the delete all run on that ONE connection inside that ONE transaction, and
  /// <c>AutomationTriggerStore</c>'s create/update take the same lock around their own
  /// action-exists check and trigger write — so a trigger created concurrently with a delete
  /// either commits first (and this read sees it and refuses) or waits and then finds the Action
  /// already gone (and fails with "Action not found."). There is no interleaving that leaves an
  /// orphan. See <see cref="Narya.Database.Common.ActionReferenceLock"/> for why neither a unique
  /// index nor optimistic concurrency can express this constraint.
  /// </para>
  /// </summary>
  public async Task<Result<bool>> DeleteAsync(Guid id, CancellationToken cancellationToken)
  {
    await using var connection = store.Storage.Database.CreateConnection();
    await connection.OpenAsync(cancellationToken).ConfigureAwait(false);
    await using var transaction = await connection.BeginTransactionAsync(cancellationToken).ConfigureAwait(false);
    await ActionReferenceLock.TakeAsync(transaction, id, cancellationToken).ConfigureAwait(false);

    // ForTransaction enlists Marten in the transaction we own, so the session borrows THIS
    // connection rather than renting a second one, and leaves the commit to us.
    await using var session = store.LightweightSession(SessionOptions.ForTransaction(transaction));

    var existing = await session.LoadAsync<ActionDocument>(id, cancellationToken).ConfigureAwait(false);
    if (existing is null)
    {
      // Roll back explicitly rather than letting disposal do it: nothing was written, but the
      // ROLLBACK is what ends the transaction and so releases the lock for the next waiter.
      await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
      return Result.Ok(false);
    }

    var referencing = await AutomationTriggerQueries.ByActionIdAsync(session, id, cancellationToken).ConfigureAwait(false);
    if (referencing.Count > 0)
    {
      await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
      return Result.Fail<bool>(new ActionInUseError(existing.Name, [.. referencing.Select(ActionTriggerReference.From)]));
    }

    session.Delete<ActionDocument>(id);
    await session.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
    await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
    return Result.Ok(true);
  }

  /// <summary>
  /// Every step gets a FRESH id and its array-index position on every save, regardless of what
  /// the input carried — matches legacy's delete-all-reinsert <c>saveSteps</c>, where a step's id
  /// is not stable across saves. `with` on an abstract-typed variable still dispatches through the
  /// runtime type's record clone, so this needs no per-type switch.
  /// </summary>
  private static List<ActionStep> AssignStepIdentity(IReadOnlyList<ActionStep> steps) =>
    [.. steps.Select((step, index) => step with { Id = Guid.NewGuid(), Position = index })];

  /// <summary>
  /// Wraps <c>SaveChangesAsync</c> and translates the case-insensitive unique-name index violation
  /// (<c>NaryaMartenConfig</c>'s <c>ActionDocument.Name</c> index) into a
  /// <see cref="DuplicateActionNameError"/> instead of letting the raw Postgres exception
  /// propagate — mirrors legacy's <c>isUniqueNameError</c>.
  /// </summary>
  private static async Task<Result> TrySaveAsync(IDocumentSession session, string name, CancellationToken cancellationToken)
  {
    try
    {
      await session.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
      return Result.Ok();
    }
    catch (Exception ex) when (IsUniqueNameViolation(ex))
    {
      return Result.Fail(new DuplicateActionNameError(name));
    }
  }

  /// <summary>
  /// Walks the exception chain (Marten wraps the underlying Postgres failure in
  /// <c>MartenCommandException</c>) looking for Postgres SQLSTATE 23505 (unique_violation) —
  /// typed, not a message-substring check, unlike legacy's SQLite-era
  /// <c>error.message.toLowerCase().includes('unique')</c>.
  /// </summary>
  private static bool IsUniqueNameViolation(Exception error)
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

  private static AutomationAction ToAction(ActionDocument doc) => new(
    Id: doc.Id,
    Name: doc.Name,
    Description: doc.Description,
    Enabled: doc.Enabled,
    QuickDisable: doc.QuickDisable,
    Steps: [.. doc.Steps.OrderBy(s => s.Position)],
    CreatedAt: doc.CreatedAt,
    UpdatedAt: doc.UpdatedAt);
}
