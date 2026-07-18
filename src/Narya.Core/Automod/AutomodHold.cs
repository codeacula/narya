namespace Narya.Core.Automod;

/// <summary>
/// A message AutoMod flagged and held for moderator review — a port of legacy's <c>AutomodHold</c>
/// (<c>legacy/src/shared/api.ts</c>). <see cref="Id"/> is Twitch's own message id, the natural
/// key <c>Narya.Core.Automod.IAutomodStore.RecordHoldAsync</c> dedups a redelivery against.
///
/// <see cref="ResolvedAt"/>/<see cref="Resolution"/>/<see cref="ResolvedBy"/> default null on a
/// freshly-held message; <c>Narya.Database.Automod.AutomodStore.RecordHoldAsync</c> always
/// inserts with these three null regardless of what a caller happens to populate them with on
/// the input record — matching legacy's <c>insertAutomodHold</c>, whose <c>values (...)</c>
/// clause hardcodes <c>null, null, null</c> for the trailing three columns rather than trusting
/// the caller. <see cref="Resolution"/> is one of <c>allowed</c>, <c>denied</c>, or <c>expired</c>
/// once set.
/// </summary>
public sealed record AutomodHold(
  string Id,
  string Channel,
  string Username,
  string DisplayName,
  string Message,
  string? Category,
  int? Level,
  DateTimeOffset HeldAt,
  DateTimeOffset? ResolvedAt = null,
  string? Resolution = null,
  string? ResolvedBy = null);

/// <summary>
/// The <c>GET /api/automod/queue</c> response shape — a port of legacy's <c>AutomodQueue</c>
/// (<c>legacy/src/shared/api.ts</c>). See <c>IAutomodStore.GetQueueAsync</c> for the exact
/// ordering/window rules behind <see cref="Pending"/>/<see cref="RecentlyResolved"/>.
/// </summary>
public sealed record AutomodQueue(IReadOnlyList<AutomodHold> Pending, IReadOnlyList<AutomodHold> RecentlyResolved);

/// <summary>
/// Result of <see cref="IAutomodStore.ResolveHoldAsync"/> — mirrors the shape convention
/// <c>Narya.Core.Sessions.SessionChatterResult</c> already established for "the entity plus a
/// signal the caller cannot otherwise reconstruct." <see cref="Changed"/> is that signal: the
/// three-way idempotency rule means the returned <see cref="Hold"/> can legitimately carry the
/// SAME field values on a genuine change and on a no-op alike (e.g. a duplicate authoritative
/// "denied" against an already-"denied" hold), so a caller cannot infer "did a broadcast-worthy
/// change just happen?" from the hold's contents alone — it needs this flag, computed atomically
/// inside the same store call that decided whether to write. <see cref="Hold"/> is null only when
/// <see cref="IAutomodStore.ResolveHoldAsync"/>'s <c>id</c> matched no stored hold at all, in
/// which case <see cref="Changed"/> is always false.
/// </summary>
public sealed record AutomodResolveResult(AutomodHold? Hold, bool Changed);
