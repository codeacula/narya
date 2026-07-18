namespace Narya.Core.Viewers;

/// <summary>
/// A stored per-viewer profile note — a port of legacy's <c>viewer_profiles</c> table
/// (<c>legacy/src/server/db.ts</c>). <see cref="Login"/> (lowercased) is the natural key.
/// <see cref="CreatedAt"/> is stamped once, on the first insert, and never touched again —
/// see <c>Narya.Core.Viewers.IViewerStore.UpsertProfileAsync</c>'s doc comment for why that
/// needs explicit care in a Marten port (unlike legacy's SQL, which gets it for free from
/// <c>ON CONFLICT DO UPDATE</c>'s column-level semantics).
/// </summary>
public sealed record ViewerProfile(
  string Login,
  string RealName,
  IReadOnlyList<string> Tags,
  string Note,
  DateTimeOffset CreatedAt,
  DateTimeOffset UpdatedAt);

/// <summary>
/// The normalized, always-valid shape returned by <c>PATCH /api/dashboard/viewers/:login/profile</c>
/// — a port of legacy's <c>ViewerProfileUpdate</c> (<c>legacy/src/shared/api.ts</c>) and the
/// return value of <c>normalizeViewerProfileBody</c>
/// (<c>legacy/src/server/dashboard/status.ts</c>). Every field is non-nullable because this is
/// the OUTPUT of normalization — <see cref="ViewerProfileUpdateRequest"/> is the nullable,
/// possibly-invalid wire input this is built from.
/// </summary>
public sealed record ViewerProfileUpdate(string RealName, IReadOnlyList<string> Tags, string Note);

/// <summary>
/// The wire shape of a <c>PATCH /api/dashboard/viewers/:login/profile</c> request body — every
/// field optional/nullable, matching legacy's <c>normalizeViewerProfileBody(body: unknown)</c>,
/// which tolerated a missing or wrongly-typed field rather than requiring a complete object.
/// <c>Narya.Application.Viewers.UpdateViewerProfileCommandValidator</c> rejects a field that is
/// present but out of bounds (too long, too many tags); <see cref="ViewerProfileNormalizer"/>
/// then trims/dedupes whatever is left into a <see cref="ViewerProfileUpdate"/>.
/// </summary>
public sealed record ViewerProfileUpdateRequest(string? RealName, IReadOnlyList<string>? Tags, string? Note);
