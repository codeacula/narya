using Marten;

using Narya.Core.Automation;

namespace Narya.Database.Automation;

/// <summary>
/// Trigger reads that more than one store needs, expressed against a CALLER-SUPPLIED session.
///
/// <para>
/// <c>Narya.Database.Actions.ActionStore.DeleteAsync</c> must run
/// <see cref="ByActionIdAsync"/> inside its own advisory-locked transaction (see
/// <c>Narya.Database.Common.ActionReferenceLock</c>) — going through
/// <see cref="IAutomationTriggerStore.GetByActionIdAsync"/> would open a second session, and
/// therefore rent a second pooled connection while holding the lock on the first. Taking the
/// session as a parameter is what lets both callers share one query and one connection instead of
/// duplicating the LINQ and the document→domain mapping.
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
