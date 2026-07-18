using FluentResults;

using Marten;

using Narya.Core.Actions;
using Narya.Core.Automation;

namespace Narya.Database.Automation;

/// <summary>
/// <see cref="IAutomationTriggerStore"/> backed by the plain (non-event-sourced)
/// <see cref="AutomationTriggerDocument"/> — mirrors legacy's <c>automationTriggers.ts</c> store
/// half.
///
/// <para>
/// <b>Field-shape validation lives in <see cref="AutomationTriggerValidation"/>, not here.</b> This
/// store adds the one check that needs I/O: <see cref="AutomationTriggerUpsert.ActionId"/> must
/// reference an existing <c>Narya.Core.Actions.AutomationAction</c> (via the injected
/// <see cref="IActionStore"/> — never a raw Marten query against
/// <c>Narya.Database.Actions.ActionDocument</c>, so this store depends only on the Narya.Core
/// contract, same reference discipline as everywhere else in this codebase). A missing Action
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
public sealed class AutomationTriggerStore(IDocumentStore store, IActionStore actionStore, TimeProvider timeProvider) : IAutomationTriggerStore
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

  public async Task<Result<AutomationTrigger>> CreateAsync(AutomationTriggerUpsert upsert, CancellationToken cancellationToken)
  {
    var normalized = AutomationTriggerValidation.Normalize(upsert);
    if (normalized.IsFailed)
    {
      return Result.Fail<AutomationTrigger>(normalized.Errors);
    }

    var actionExistsResult = await EnsureActionExistsAsync(normalized.Value.ActionId, cancellationToken).ConfigureAwait(false);
    if (actionExistsResult.IsFailed)
    {
      return Result.Fail<AutomationTrigger>(actionExistsResult.Errors);
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

    await using var session = store.LightweightSession();
    session.Insert(doc);
    await session.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
    return Result.Ok(ToTrigger(doc));
  }

  public async Task<Result<AutomationTrigger>?> UpdateAsync(Guid id, AutomationTriggerUpsert upsert, CancellationToken cancellationToken)
  {
    await using var session = store.LightweightSession();
    var existing = await session.LoadAsync<AutomationTriggerDocument>(id, cancellationToken).ConfigureAwait(false);
    if (existing is null)
    {
      return null;
    }

    var normalized = AutomationTriggerValidation.Normalize(upsert);
    if (normalized.IsFailed)
    {
      return Result.Fail<AutomationTrigger>(normalized.Errors);
    }

    var actionExistsResult = await EnsureActionExistsAsync(normalized.Value.ActionId, cancellationToken).ConfigureAwait(false);
    if (actionExistsResult.IsFailed)
    {
      return Result.Fail<AutomationTrigger>(actionExistsResult.Errors);
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

    session.Store(updated);
    await session.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
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

  private async Task<Result> EnsureActionExistsAsync(Guid actionId, CancellationToken cancellationToken)
  {
    var action = await actionStore.GetByIdAsync(actionId, cancellationToken).ConfigureAwait(false);
    return action is null ? Result.Fail("Action not found.") : Result.Ok();
  }

  private static AutomationTrigger ToTrigger(AutomationTriggerDocument doc) => new(
    Id: doc.Id,
    Kind: doc.Kind,
    ActionId: doc.ActionId,
    ModuleId: doc.ModuleId,
    Enabled: doc.Enabled,
    GlobalCooldownMs: doc.GlobalCooldownMs,
    UserCooldownMs: doc.UserCooldownMs,
    Config: doc.Config,
    CreatedAt: doc.CreatedAt,
    UpdatedAt: doc.UpdatedAt);
}
