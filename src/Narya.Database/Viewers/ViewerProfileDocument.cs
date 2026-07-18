namespace Narya.Database.Viewers;

/// <summary>
/// The mutable <c>viewer_profiles</c> projection — a port of legacy's table
/// (<c>legacy/src/server/db.ts</c>). <see cref="Login"/> (lowercased) is the natural
/// key/identity, configured via <c>options.Schema.For&lt;ViewerProfileDocument&gt;().Identity(x
/// =&gt; x.Login)</c> in <c>Narya.Database.NaryaMartenConfig</c> — the same no-separate-Id
/// pattern <see cref="ChatterDocument"/> uses.
///
/// <see cref="CreatedAt"/> is written once, by <c>ViewerStore.UpsertProfileAsync</c>'s
/// first-insert branch, and never touched again — see that method's (and
/// <c>Narya.Core.Viewers.IViewerStore.UpsertProfileAsync</c>'s) doc comment for why a Marten
/// port of this upsert needs to guard that explicitly.
/// </summary>
public sealed record ViewerProfileDocument
{
  public string Login { get; init; } = string.Empty;

  public string RealName { get; init; } = string.Empty;

  /// <summary>JSON-encoded <c>string[]</c> — mirrors legacy's <c>tags_json</c> column.</summary>
  public string TagsJson { get; init; } = "[]";

  public string Note { get; init; } = string.Empty;

  public DateTimeOffset CreatedAt { get; init; }

  public DateTimeOffset UpdatedAt { get; init; }
}
