using Narya.Core.Automation;

namespace Narya.Database.Automation;

/// <summary>
/// The <c>automation_triggers</c> projection — a plain (non-event-sourced) Marten document, a port
/// of legacy's table (<c>legacy/src/server/db.ts</c>). <see cref="Config"/> reuses
/// <c>Narya.Core.Automation.TriggerConfig</c> DIRECTLY as the storage field, the same choice
/// <c>Narya.Database.Actions.ActionDocument.Steps</c> makes for <c>ActionStep</c> — see that type's
/// doc comment for why a separate storage-only DTO is not worth it here either.
///
/// <para>
/// Must be public — Marten generates document-storage code at runtime and a private/internal
/// document type fails storage codegen (the same lesson <c>MartenSmokeTests.Doc</c> documents).
/// </para>
/// </summary>
public sealed record AutomationTriggerDocument
{
  public Guid Id { get; init; }

  public AutomationTriggerKind Kind { get; init; }

  public Guid ActionId { get; init; }

  /// <summary>Null = global. See <see cref="AutomationTrigger"/>'s doc comment for the Phase 8 module-scoping note.</summary>
  public Guid? ModuleId { get; init; }

  public bool Enabled { get; init; } = true;

  public required TriggerConfig Config { get; init; }

  public int GlobalCooldownMs { get; init; }

  public int UserCooldownMs { get; init; }

  public DateTimeOffset CreatedAt { get; init; }

  public DateTimeOffset UpdatedAt { get; init; }
}
