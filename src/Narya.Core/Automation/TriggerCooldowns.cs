namespace Narya.Core.Automation;

/// <summary>
/// The cooldown window a claim must be admitted through, in milliseconds — the gate that used to
/// live in <c>Narya.Application.Automation.TriggerDispatcher</c> as a read of the last run
/// FOLLOWED by an unrelated claim insert. That ordering had a TOCTOU gap two DIFFERENT concurrent
/// events could both pass (the dedupe key only collides for the SAME event id), so both fired
/// inside one cooldown window. Passing the window down into
/// <see cref="IAutomationRunStore.TryClaimAsync"/> instead lets the store make admission and claim
/// one serialized database operation — see that method's doc comment.
/// </summary>
/// <param name="GlobalCooldownMs">Per-trigger window; <c>0</c> or less disables the global gate.</param>
/// <param name="UserCooldownMs">Per-trigger-per-actor window; <c>0</c> or less (or a null actor login) disables the user gate.</param>
public readonly record struct TriggerCooldowns(int GlobalCooldownMs, int UserCooldownMs)
{
  /// <summary>
  /// No cooldown gate at all — what a caller passes when it is deliberately bypassing gates
  /// (a manual run, or a module-lifecycle invocation, i.e. <c>TriggerInvokeOptions.EnforceGates</c>
  /// false). Dedupe still applies; only the cooldown admission is skipped.
  /// </summary>
  public static TriggerCooldowns None => default;

  /// <summary>Whether either window is worth a database round trip — false means the claim is a plain insert.</summary>
  public bool Enforced => GlobalCooldownMs > 0 || UserCooldownMs > 0;
}
