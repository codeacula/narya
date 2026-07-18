using System.Text.Json.Serialization;

namespace Narya.Core.Viewers;

/// <summary>
/// One entry of <c>GET /api/dashboard/viewers</c> — the recent-activity projection over the
/// last <c>DASHBOARD_RECENT_VIEWER_MESSAGE_LIMIT</c> (500) chat messages, keyed by lowercased
/// login (<c>IReadOnlyDictionary&lt;string, Viewer&gt;</c> mirrors legacy's
/// <c>Record&lt;string, Viewer&gt;</c>). A port of legacy's <c>Viewer</c>
/// (<c>legacy/src/shared/api.ts</c>), scoped down to the fields the Phase 3 plan's Task 5
/// description actually asks this projection to compute: <see cref="Followed"/>/
/// <see cref="AccountAge"/> stay the literal <c>"not available"</c> until a later phase wires
/// live Twitch Helix lookups (see the Phase 3 plan's "Deferred to later phases": "Viewer Helix
/// details ... Phase 8"). Legacy's <c>realName</c>/<c>tags</c>/<c>msgs</c>/<c>seen</c>/<c>note</c>
/// fields — sourced from the exact same <c>chatters</c>/<c>viewer_profiles</c> data
/// <see cref="ViewerRosterEntry"/> already exposes via <c>GET /api/viewers/roster</c> — are
/// deliberately not duplicated onto this projection.
/// </summary>
public sealed record Viewer(
  string Display,
  string Color,
  IReadOnlyList<string> Roles,
  string Followed,
  string Subbed,
  string AccountAge,
  IReadOnlyList<ViewerRecentMessage> Recent);

/// <summary>
/// One recent message shown on a viewer's quick-info card — a port of legacy's inline
/// <c>Viewer['recent']</c> entry shape (<c>legacy/src/shared/api.ts</c>: <c>{ t, ago, kind?,
/// emotes? }</c>). <see cref="Text"/> serializes as <c>"t"</c> to match that short legacy field
/// name. <see cref="ReceivedAt"/> is wire-invisible (<see cref="JsonIgnoreAttribute"/>) and
/// exists only so <c>Narya.Application.Viewers.GetRecentViewersQueryHandler</c> can stamp
/// <see cref="Ago"/> from it after the fact — the same raw-then-enriched split
/// <c>Narya.Core.Events.StreamEvent.Ago</c> uses, and for the same reason:
/// <c>Narya.Database.Viewers.ViewerStore</c> must not need a clock to answer a query.
/// </summary>
public sealed record ViewerRecentMessage(
  [property: JsonPropertyName("t")] string Text,
  [property: JsonIgnore] DateTimeOffset ReceivedAt,
  IReadOnlyDictionary<string, IReadOnlyList<string>>? Emotes,
  string? Ago = null);
