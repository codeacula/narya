using FluentResults;

using Marten;

using Narya.Core.Actions;

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

  public async Task<bool> DeleteAsync(Guid id, CancellationToken cancellationToken)
  {
    await using var session = store.LightweightSession();
    var existing = await session.LoadAsync<ActionDocument>(id, cancellationToken);
    if (existing is null)
    {
      return false;
    }

    session.Delete<ActionDocument>(id);
    await session.SaveChangesAsync(cancellationToken);
    return true;
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
