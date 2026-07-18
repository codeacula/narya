using Narya.Core.Actions;

namespace Narya.Database.Automation;

/// <summary>
/// The <c>automation_runs</c> projection — a plain (non-event-sourced) Marten document, a port of
/// legacy's table (<c>legacy/src/server/db.ts:414-428</c>). Doubles as the dedupe table:
/// <see cref="DedupeKey"/> holds <c>"{triggerId}:{eventId}"</c> for a chat message, EventSub
/// message, or reward redemption, so a redelivery of the same source event for the same trigger is
/// a no-op — see <c>NaryaMartenConfig</c>'s partial unique index over this field and
/// <c>Narya.Core.Automation.IAutomationRunStore.TryClaimAsync</c>'s doc comment for the insert-wins
/// mechanism.
///
/// <para>
/// Must be public — Marten generates document-storage code at runtime and a private/internal
/// document type fails storage codegen (the same lesson <c>MartenSmokeTests.Doc</c> documents).
/// </para>
/// </summary>
public sealed record AutomationRunDocument
{
  public Guid Id { get; init; }

  public Guid TriggerId { get; init; }

  /// <summary><c>"{triggerId}:{eventId}"</c>, or null for a manual/module-lifecycle invocation that has no source event id — see this type's doc comment.</summary>
  public string? DedupeKey { get; init; }

  /// <summary>Lowercased actor login, when the invocation is attributable to one viewer — the user-cooldown scope.</summary>
  public string? ActorLogin { get; init; }

  public required ActionRunStatus Status { get; init; }

  public string Detail { get; init; } = string.Empty;

  public DateTimeOffset RanAt { get; init; }
}
