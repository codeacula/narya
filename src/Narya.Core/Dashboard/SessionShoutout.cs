namespace Narya.Core.Dashboard;

/// <summary>
/// Everyone worth thanking so far this stream session, grouped per actor — a port of legacy's
/// <c>SessionShoutout</c> (<c>legacy/src/shared/api.ts</c>), produced by
/// <c>Narya.Application.Dashboard.GetSessionShoutoutsQueryHandler</c> (the grouping logic mirrors
/// legacy's <c>getSessionShoutouts</c> in <c>legacy/src/server/dashboard/status.ts</c>). Drives
/// the dashboard's Shoutouts tab and the <c>/overlay/shoutouts</c> ticker.
///
/// <see cref="Login"/> is null for rows recorded before logins were stored (matches legacy) —
/// grouping falls back to <see cref="Actor"/> (lowercased) as the key in that case, so the same
/// person can still end up merged into one entry once a login-bearing row exists for them.
/// <see cref="Kinds"/> is a de-duplicated, order-of-first-appearance list (e.g. a follow then a
/// resub in the same session yields <c>["follow", "sub"]</c>, not two entries). <see cref="Detail"/>
/// is always the MOST RECENT event's detail for that actor — "a resub says more than the follow
/// that preceded it", per legacy's comment on this exact field. <see cref="FirstAt"/>/
/// <see cref="LastAt"/> span the actor's earliest and latest thank-worthy event this session.
/// </summary>
public sealed record SessionShoutout(
  string Actor,
  string? Login,
  IReadOnlyList<string> Kinds,
  string Detail,
  DateTimeOffset FirstAt,
  DateTimeOffset LastAt);
