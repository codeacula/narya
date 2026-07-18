using Marten;

using Narya.Core.Automation;

namespace Narya.Database.Automation;

/// <summary>
/// Trigger reads that more than one store needs, expressed against a CALLER-SUPPLIED session.
///
/// <para>
/// <c>Narya.Database.Actions.ActionStore.DeleteAsync</c> must run
/// <see cref="ByActionIdAsync"/> inside its own advisory-locked transaction (see
/// <c>Narya.Database.Common.ActionReferenceLock</c>). Taking the session as a PARAMETER — rather
/// than exposing this read on <see cref="IAutomationTriggerStore"/> — is the whole point: a port
/// method would have to open its own session, and therefore rent a second pooled connection while
/// the caller still holds the advisory lock on the first, which is exactly the pool inversion
/// <c>AutomationRunStore.TryClaimAsync</c> documents. There was such a port method
/// (<c>GetByActionIdAsync</c>); it had no callers and no tests, and was removed rather than left
/// as a correct-looking trap for the next caller who needs this read under a lock.
/// </para>
/// </summary>
internal static class AutomationTriggerQueries
{
  /// <summary>
  /// Every trigger referencing <paramref name="actionId"/>, enabled or not, in creation order.
  /// Backed by <c>NaryaMartenConfig</c>'s <c>ActionId</c> index.
  /// </summary>
  public static async Task<IReadOnlyList<AutomationTrigger>> ByActionIdAsync(
    IQuerySession session, Guid actionId, CancellationToken cancellationToken)
  {
    var docs = await session.Query<AutomationTriggerDocument>()
      .Where(d => d.ActionId == actionId)
      .ToListAsync(cancellationToken)
      .ConfigureAwait(false);
    return [.. docs.Select(ToTrigger).OrderBy(t => t.CreatedAt)];
  }

  public static AutomationTrigger ToTrigger(AutomationTriggerDocument doc) => new(
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
