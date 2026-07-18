namespace Narya.Core.Viewers;

/// <summary>
/// One row of <c>GET /api/viewers/roster</c> — a port of legacy's <c>ViewerRosterEntry</c>
/// (<c>legacy/src/shared/api.ts</c>): everyone who has ever chatted, drawn from the persistent
/// <c>chatters</c> table joined to each person's most recent message for a current display
/// name/color/badges, merged with their <c>viewer_profiles</c> note. See
/// <c>Narya.Core.Viewers.IViewerStore.GetRosterAsync</c> for the query shape.
/// </summary>
public sealed record ViewerRosterEntry(
  string Login,
  string Display,
  string Color,
  IReadOnlyList<string> Roles,
  int MessageCount,
  DateTimeOffset FirstSeenAt,
  DateTimeOffset LastSeenAt,
  string Note);
