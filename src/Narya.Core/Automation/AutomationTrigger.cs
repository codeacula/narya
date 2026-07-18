namespace Narya.Core.Automation;

/// <summary>
/// The source that fires an <c>Action</c> — a port of legacy's <c>AutomationTriggerKind</c>
/// (<c>legacy/src/shared/api.ts:868</c>). Always derived from <see cref="TriggerConfig"/>'s
/// concrete type by <see cref="AutomationTriggerValidation.KindOf"/> — see <see cref="TriggerConfig"/>'s
/// doc comment for why a caller never sets this independently.
/// </summary>
public enum AutomationTriggerKind
{
  Reward = 0,
  TwitchEvent = 1,
  ChatPhrase = 2,
  ViewerCommand = 3,
  DashboardSlash = 4,
  Manual = 5,
  ModuleActivate = 6,
  ModuleDeactivate = 7,
}

/// <summary>
/// A typed source that fires a <c>Narya.Core.Actions.AutomationAction</c> — a port of legacy's
/// discriminated-union <c>AutomationTrigger</c> (<c>legacy/src/shared/api.ts:876-884</c>). A trigger
/// with a <see langword="null"/> <see cref="ModuleId"/> is global (always armed); a non-null one is
/// scoped to a category module.
///
/// <para>
/// <b>Module scoping is dormant until Phase 8.</b> <c>category_modules</c> (legacy's module
/// existence check, <c>legacy/src/server/automationTriggers.ts:96,223</c>) does not exist in this
/// codebase yet — Phase 8 owns it. Rather than inventing a module-existence port that would always
/// return <see langword="false"/> and block every module-scoped trigger from EVER being created
/// (worse than legacy, which lets an operator create one against a module that already exists), this
/// store accepts any non-null <see cref="ModuleId"/> unvalidated: Phase 4 has nothing to check it
/// against, and nothing before Phase 8's coordinator (<c>getActiveModuleId</c>) reads
/// <see cref="ModuleId"/> at all, so a module-scoped trigger simply sits inert — never matched by
/// <c>HandleModuleLifecycle</c> (Task 6) and never armed by <c>isArmed</c> (Task 6, which treats
/// "module active" as false until Phase 8) — until Phase 8 ships both the module table and the
/// coordinator that populates it. See this plan's Task 5 for the alternatives considered.
/// </para>
/// </summary>
public sealed record AutomationTrigger(
  Guid Id,
  AutomationTriggerKind Kind,
  Guid ActionId,
  Guid? ModuleId,
  bool Enabled,
  int GlobalCooldownMs,
  int UserCooldownMs,
  TriggerConfig Config,
  DateTimeOffset CreatedAt,
  DateTimeOffset UpdatedAt);

/// <summary>
/// The request body for both <c>POST /api/automation/triggers</c> and
/// <c>PUT /api/automation/triggers/{id}</c> — a port of legacy's <c>AutomationTriggerInput</c>.
/// Like <c>Narya.Core.Actions.ActionUpsert</c>, this is NOT a partial patch: PUT always replaces the
/// whole entity. <see cref="Config"/> is nullable (absent input) rather than defaulting to some
/// arbitrary concrete kind — <see cref="AutomationTriggerValidation.Normalize"/> fails a null
/// config exactly like legacy fails an unrecognized/missing <c>kind</c> string.
/// </summary>
public sealed record AutomationTriggerUpsert
{
  public Guid ActionId { get; init; }

  /// <summary>Null = global (always armed regardless of the active category module).</summary>
  public Guid? ModuleId { get; init; }

  public bool Enabled { get; init; } = true;

  /// <summary>
  /// Absent (<see langword="null"/>) falls back to <see cref="AutomationTriggerValidation.DefaultGlobalCooldownMs"/>;
  /// an explicit <c>0</c> is preserved as-is (disables the cooldown) rather than falling back —
  /// mirrors legacy's <c>value === undefined || value === null</c> distinction, which is why this
  /// is a nullable <see langword="int"/> rather than defaulting to 0 in the property initializer.
  /// </summary>
  public int? GlobalCooldownMs { get; init; }

  /// <summary>Same absent-vs-zero distinction as <see cref="GlobalCooldownMs"/>.</summary>
  public int? UserCooldownMs { get; init; }

  /// <summary>The trigger's kind-specific configuration — see this type's doc comment.</summary>
  public TriggerConfig? Config { get; init; }
}

/// <summary>
/// The fully-normalized values <see cref="AutomationTriggerValidation.Normalize"/> produces from an
/// <see cref="AutomationTriggerUpsert"/> — ready to persist once the caller (the store) has also
/// confirmed <see cref="ActionId"/> exists, which needs I/O this pure validator does not perform.
/// </summary>
public sealed record NormalizedAutomationTrigger(
  AutomationTriggerKind Kind,
  Guid ActionId,
  Guid? ModuleId,
  bool Enabled,
  int GlobalCooldownMs,
  int UserCooldownMs,
  TriggerConfig Config);
