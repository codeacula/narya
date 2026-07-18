using Narya.Core.Actions;

namespace Narya.Database.Actions;

/// <summary>
/// The <c>actions</c> + <c>action_steps</c> projection — a single plain (non-event-sourced)
/// Marten document that EMBEDS its ordered steps as a JSONB array, rather than mirroring legacy's
/// two-table shape (<c>legacy/src/server/db.ts</c>). A save always REPLACES the whole
/// <see cref="Steps"/> list — Marten has no notion of a per-step PATCH — which is exactly legacy's
/// own <c>saveSteps</c> semantics (<c>deleteStepsForAction</c> then bulk <c>insertStepRow</c> on
/// every Create/Update): one embedded-list write reproduces "delete-all-reinsert" for free,
/// instead of a literal delete+insert pair against a child table.
///
/// <para>
/// <see cref="ActionStep"/> (Narya.Core) is reused DIRECTLY as the embedded element type, rather
/// than a separate storage-only DTO the way <c>Narya.Database.Media.MediaAssetDocument</c> mirrors
/// <c>Narya.Core.Media.MediaAsset</c> with plain-string enums. That precedent exists specifically
/// because a bare C#/Marten enum's wire form depends on <c>EnumStorage</c> serializer settings;
/// <see cref="ActionStep"/>'s discriminator is instead an explicit string literal that
/// <see cref="ActionStepJsonConverter"/> controls directly (not derived from an enum's storage
/// format), so that risk does not apply — doubling all 11 step-payload types into a storage-only
/// mirror here would be ceremony without a matching robustness gain. See
/// <see cref="ActionStep"/>'s and <see cref="ActionStepJsonConverter"/>'s doc comments for the
/// full polymorphic JSON design, including why a hand-written converter replaced the BCL's
/// <c>[JsonPolymorphic]</c>/<c>[JsonDerivedType]</c> attributes (discovered via this project's own
/// Testcontainers tests: Marten's <c>SystemTextJsonSerializer</c> does not preserve "discriminator
/// property first" ordering on write, which the BCL's polymorphic reader requires).
/// </para>
///
/// <para>Must be public — Marten generates document-storage code at runtime and a private/internal
/// document type fails storage codegen (the same lesson <c>MartenSmokeTests.Doc</c> documents).</para>
/// </summary>
public sealed record ActionDocument
{
  public Guid Id { get; init; }

  /// <summary>Case-insensitive unique — see <c>NaryaMartenConfig</c>'s index registration.</summary>
  public string Name { get; init; } = string.Empty;

  public string Description { get; init; } = string.Empty;

  public bool Enabled { get; init; } = true;

  /// <summary>When true, the executor (Phase 4 Task 3) skips this Action's whole run while media-muted.</summary>
  public bool QuickDisable { get; init; }

  /// <summary>Ordered by <see cref="ActionStep.Position"/>. A save replaces this list wholesale.</summary>
  public List<ActionStep> Steps { get; init; } = [];

  public DateTimeOffset CreatedAt { get; init; }

  public DateTimeOffset UpdatedAt { get; init; }
}
