namespace Narya.Core.Actions;

/// <summary>
/// A named, reusable, ordered sequence of <see cref="ActionStep"/>s — a port of legacy's
/// <c>Action</c> (<c>legacy/src/shared/api.ts</c>). Named <c>AutomationAction</c> rather than
/// <c>Action</c>: this project has <c>ImplicitUsings</c> enabled, which brings
/// <see cref="System.Action"/> into scope in every file, and <c>System.Action</c>/<c>Action&lt;T&gt;</c>
/// delegates are used pervasively (Marten configuration lambdas, ASP.NET middleware, etc.) — a
/// bare <c>Narya.Core.Actions.Action</c> would collide with it (CS0104) the moment a file needs
/// both a delegate and this type, which Phase 4 Task 3's executor definitely will. The interfaces
/// and files around it keep the un-prefixed name (<see cref="IActionStore"/>, <c>ActionStep</c>,
/// <c>ActionUpsert</c>, <c>ActionsController</c>) since none of those bare identifiers collide.
/// </summary>
/// <param name="QuickDisable">When true, the executor (Task 3) skips this Action's whole run while media-muted.</param>
public sealed record AutomationAction(
  Guid Id,
  string Name,
  string Description,
  bool Enabled,
  bool QuickDisable,
  IReadOnlyList<ActionStep> Steps,
  DateTimeOffset CreatedAt,
  DateTimeOffset UpdatedAt);

/// <summary>
/// The request body for both <c>POST /api/actions</c> and <c>PUT /api/actions/{id}</c> — a port
/// of legacy's <c>ActionUpsert</c>. Unlike <c>Narya.Core.Media.MediaAssetPatch</c>, this is NOT a
/// partial patch: legacy's <c>normalizeActionUpsert</c> is the same function for create and
/// update, and PUT always replaces the whole entity (full <see cref="Steps"/> list included) —
/// there is no "absent field falls back to current" behavior for Actions. Fields therefore have
/// plain code-literal defaults (matching legacy's own create-time defaults) rather than nullable
/// "absent" markers.
/// </summary>
public sealed record ActionUpsert
{
  public string Name { get; init; } = string.Empty;
  public string Description { get; init; } = string.Empty;
  public bool Enabled { get; init; } = true;
  public bool QuickDisable { get; init; }
  public IReadOnlyList<ActionStep> Steps { get; init; } = [];
}
