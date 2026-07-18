namespace Narya.Application.Automation;

/// <summary>
/// The "which category module is live" seam <c>TriggerDispatcher.IsArmed</c> checks a module-scoped
/// trigger against — a port of legacy's <c>getActiveModuleId</c> dependency
/// (<c>legacy/src/server/triggerDispatcher.ts</c>). Phase 8 owns the real category-module
/// coordinator; until then this is a capability Phase 4 does not build yet, same family as
/// <c>Narya.Application.Actions.ITtsPort</c>/<c>ILlmPort</c>/<c>IObsPort</c> — see
/// <c>IActionStepPorts.cs</c>'s top-of-file doc comment for the shared rationale (a minimal no-op
/// default now, replaced with a plain <c>AddSingleton</c> once the real implementation ships).
/// </summary>
public interface IActiveModuleProvider
{
  /// <summary>Id of the module matching the live Twitch category, or <see langword="null"/> when none matches.</summary>
  Guid? GetActiveModuleId();
}

/// <summary>
/// No-op default — always <see langword="null"/>, so every module-scoped trigger stays un-armed
/// (dormant) until Phase 8 ships the real coordinator and replaces this with a plain
/// <c>AddSingleton</c>. A global trigger (<c>ModuleId</c> null) is unaffected — see
/// <c>Narya.Application.Automation.TriggerDispatcher.IsArmed</c>. Registered
/// <c>TryAddSingleton&lt;IActiveModuleProvider, NullActiveModuleProvider&gt;</c> in
/// <c>Narya.Application.ServiceCollectionExtensions</c>.
/// </summary>
public sealed class NullActiveModuleProvider : IActiveModuleProvider
{
  public Guid? GetActiveModuleId() => null;
}
