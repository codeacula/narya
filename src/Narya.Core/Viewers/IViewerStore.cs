namespace Narya.Core.Viewers;

/// <summary>
/// Viewer profiles + roster + recent-activity projections — a port of legacy's
/// <c>viewer_profiles</c> table and the viewer-facing routes in
/// <c>legacy/src/server/dashboard/status.ts</c>. Implemented by
/// <c>Narya.Database.Viewers.ViewerStore</c>. Deliberately defined here (Narya.Core), not
/// alongside its implementation — same reference-direction constraint documented on
/// <c>Narya.Core.Chat.IChatStore</c>: <c>Narya.Application.Viewers</c> is the consumer, and
/// Narya.Application deliberately does not reference Narya.Database. Registered as
/// <c>AddSingleton&lt;IViewerStore, ViewerStore&gt;</c> in
/// <c>Narya.Database.ServiceCollectionExtensions.AddNaryaDatabase</c>.
/// </summary>
public interface IViewerStore
{
  /// <summary>
  /// Insert-or-update the <c>viewer_profiles</c> row for <paramref name="login"/> (lowercased)
  /// — a genuine upsert, not a dedup guard: unlike a chat message/event, a profile edit is
  /// legitimately idempotent-overwrite (editing a note twice should not fail or no-op the
  /// second time). Normalizes <paramref name="realName"/>/<paramref name="tags"/>/
  /// <paramref name="note"/> via <see cref="ViewerProfileNormalizer.Normalize"/> before
  /// persisting and always succeeds — REJECTING out-of-bounds input (too long, too many tags)
  /// is <c>Narya.Application.Viewers.UpdateViewerProfileCommandValidator</c>'s job, upstream of
  /// this call, not this method's.
  ///
  /// <para>
  /// <b>CreatedAt is preserved across updates.</b> <paramref name="occurredAt"/> is written to
  /// <c>CreatedAt</c> only on a genuine first insert; an update writes it to <c>UpdatedAt</c>
  /// and leaves the stored <c>CreatedAt</c> untouched. This needs explicit load-check-then-branch
  /// code in a Marten port that legacy's SQL got for free: legacy's
  /// <c>insert ... on conflict(login) do update set real_name = ..., updated_at = ...</c>
  /// updates only the COLUMNS NAMED in its <c>SET</c> clause — <c>created_at</c> is not one of
  /// them, so SQLite leaves the existing row's value alone automatically. Marten's
  /// <c>IDocumentSession.Store</c> has no such column-level granularity — it replaces the whole
  /// document — so a naive port that always wrote <c>CreatedAt = occurredAt</c> regardless of
  /// whether the document already existed WOULD silently reset <c>CreatedAt</c> on every edit.
  /// This method's contract is what stops that: implementations must load the existing document
  /// first and copy its <c>CreatedAt</c> forward on the update branch.
  /// </para>
  /// </summary>
  Task<ViewerProfileUpdate> UpsertProfileAsync(
    string login,
    string? realName,
    IReadOnlyList<string>? tags,
    string? note,
    DateTimeOffset occurredAt,
    CancellationToken cancellationToken);

  /// <summary>The stored profile for <paramref name="login"/> (case-insensitive), or <see langword="null"/> if none has ever been saved.</summary>
  Task<ViewerProfile?> GetProfileAsync(string login, CancellationToken cancellationToken);

  /// <summary>
  /// Every <c>chatters</c> row, each already carrying its own last-message fields (see
  /// <c>Narya.Database.Viewers.ChatterDocument</c>'s doc comment for why this needs no
  /// window-function join the way legacy's SQL did), merged with <c>viewer_profiles</c> notes —
  /// a port of legacy's <c>GET /api/viewers/roster</c>. Ordered by <c>LastSeenAt</c> descending
  /// (most-recently-seen first).
  /// </summary>
  Task<IReadOnlyList<ViewerRosterEntry>> GetRosterAsync(CancellationToken cancellationToken);

  /// <summary>
  /// The recent-activity projection over the <paramref name="messageScanLimit"/> most-recent
  /// <c>chat_messages</c> (legacy: <c>DASHBOARD_RECENT_VIEWER_MESSAGE_LIMIT</c> = 500) — a port
  /// of legacy's <c>GET /api/dashboard/viewers</c>. Messages are scanned newest-first; the
  /// first occurrence of a login within the scan seeds its display/color/roles, and up to 5
  /// most-recent messages per login are collected. A login with no matching <c>chatters</c> row
  /// is skipped defensively (mirrors legacy's <c>if (!count) continue;</c>).
  ///
  /// <see cref="ViewerRecentMessage.Ago"/> is left <see langword="null"/> on every returned
  /// message — the caller (<c>Narya.Application.Viewers.GetRecentViewersQueryHandler</c>) stamps
  /// it from <see cref="ViewerRecentMessage.ReceivedAt"/>, the same raw-then-enriched split
  /// <c>Narya.Core.Events.StreamEvent.Ago</c> uses, so this store never needs a clock.
  /// </summary>
  Task<IReadOnlyDictionary<string, Viewer>> GetRecentViewersAsync(int messageScanLimit, CancellationToken cancellationToken);
}
