namespace Narya.Core.Automod;

/// <summary>
/// The AutoMod held-message queue — a port of legacy's <c>automod.ts</c>. Implemented by
/// <c>Narya.Database.Automod.AutomodStore</c>.
///
/// Deliberately defined here (Narya.Core), not alongside its implementation in Narya.Database:
/// <c>Narya.Application.Automod.RecordAutomodHoldHandler</c>/<c>ResolveAutomodHoldHandler</c>/
/// <c>GetAutomodQueueQueryHandler</c> are the consumers, and Narya.Application deliberately does
/// not reference Narya.Database — the same reference-direction constraint documented on
/// <c>Narya.Core.Chat.IChatStore</c>. Registered as <c>AddSingleton&lt;IAutomodStore, AutomodStore&gt;</c>
/// in <c>Narya.Database.ServiceCollectionExtensions.AddNaryaDatabase</c>.
/// </summary>
public interface IAutomodStore
{
  /// <summary>
  /// Insert-or-ignore keyed by <see cref="AutomodHold.Id"/> — load-check-then-insert, matching
  /// <c>Narya.Database.Chat.ChatStore.TryInsertMessageAsync</c>'s pattern (never
  /// <c>session.Store</c>, which would silently overwrite a redelivery on top of the original).
  /// On a genuine insert, appends an <c>automod.hold</c> row to the <c>chat_events</c> ledger via
  /// the injected <c>Narya.Core.Chat.IChatStore</c> — matching legacy's <c>recordAutomodHold</c>,
  /// which calls <c>appendChatEvent</c> itself rather than leaving it to the caller. Returns
  /// <see langword="true"/> only on that genuine insert; a redelivered id returns
  /// <see langword="false"/>, appends nothing, and leaves the stored row untouched — the caller
  /// (<c>RecordAutomodHoldHandler</c>) must treat <see langword="false"/> as "stop, no broadcast."
  /// </summary>
  Task<bool> RecordHoldAsync(AutomodHold hold, CancellationToken cancellationToken);

  /// <summary>
  /// The three-way idempotency rule (mirrors legacy's <c>resolveAutomodHold</c> EXACTLY):
  /// <list type="bullet">
  /// <item>Unknown <paramref name="id"/> → <c>{ Hold: null, Changed: false }</c>.</item>
  /// <item>An unresolved hold → always resolves: sets <c>ResolvedAt</c> to now, <c>Resolution</c>
  /// to <paramref name="resolution"/>, <c>ResolvedBy</c> to <paramref name="resolvedBy"/>.</item>
  /// <item>An already-resolved hold → returned UNCHANGED (<c>Changed: false</c>) UNLESS
  /// <paramref name="authoritative"/> is <see langword="true"/> AND the stored
  /// <see cref="AutomodHold.Resolution"/> is <c>"expired"</c> AND <paramref name="resolution"/>
  /// is not <c>"expired"</c> — an authoritative verdict may overturn a speculative expiry
  /// (the sweep, or a "gone" allow/deny outcome) exactly once. Two authoritative results never
  /// race: whichever call observes the hold as still unresolved (or still speculatively expired)
  /// first is the one that writes; the second sees the now-resolved (non-"expired") row and is a
  /// no-op.</item>
  /// </list>
  /// On an actual write, also appends an <c>automod.resolve</c> row to the <c>chat_events</c>
  /// ledger via the injected <c>Narya.Core.Chat.IChatStore</c> — same "the store does its own
  /// audit trail" pattern as <see cref="RecordHoldAsync"/>. The load-check-then-conditionally-write
  /// happens inside a single Marten <c>IDocumentSession</c>, so the idempotency decision and the
  /// write it gates are atomic WITHIN that session — no other operation on the SAME session can
  /// observe a state between them. That is not the same as unraceable: a lightweight session is a
  /// unit of work, not a read-locked transaction, so two DIFFERENT sessions (e.g. the HTTP
  /// allow/deny route and a concurrent EventSub dispatch) can each load the hold as unresolved
  /// before either calls <c>SaveChangesAsync</c>, and both then write. The three-way idempotency
  /// rule above still leaves the system in a sane end state when that happens (whichever save
  /// lands last simply overwrites with an equivalent resolution, since both derive from the same
  /// underlying Helix action) — but it is a benign accident of both callers agreeing on the
  /// outcome, not a guarantee this method enforces across sessions.
  /// </summary>
  Task<AutomodResolveResult> ResolveHoldAsync(
    string id, string resolution, string? resolvedBy, bool authoritative, CancellationToken cancellationToken);

  /// <summary>The stored hold for <paramref name="id"/>, or null if none exists.</summary>
  Task<AutomodHold?> GetHoldAsync(string id, CancellationToken cancellationToken);

  /// <summary>
  /// Resolves every unresolved hold whose <see cref="AutomodHold.HeldAt"/> is older than the
  /// hold-expiry window (2 hours) as <c>"expired"</c>, NON-authoritatively — so a later real
  /// verdict (an authoritative <see cref="ResolveHoldAsync"/> call) can still overturn it exactly
  /// once. Mirrors legacy's <c>sweepExpiredHolds</c>: Twitch auto-expires held messages well
  /// inside an hour, so this is a conservative safety net for a hold whose <c>update</c> event
  /// this process missed (a socket drop, or downtime), reusing <see cref="ResolveHoldAsync"/> so
  /// each swept hold still gets its own audit-trail row and idempotency guarantees.
  ///
  /// <para>
  /// Returns exactly the holds this call actually swept to <c>"expired"</c> (never one that a
  /// concurrent, separate session resolved first — see <see cref="ResolveHoldAsync"/>'s doc
  /// comment on why two sessions can race). This store is deliberately mediator-free (see this
  /// interface's class doc comment), so it CANNOT broadcast <c>automod:resolved</c> itself for a
  /// hold it silently expires — the caller, <c>Narya.Application.Automod.GetAutomodQueueQueryHandler</c>,
  /// calls this FIRST and publishes one <c>AutomodResolvedBroadcastNotification</c> per returned
  /// hold before calling <see cref="GetQueueAsync"/>. Without that, a second operator client would
  /// keep showing a swept hold as pending forever — it would only learn otherwise the next time
  /// IT happens to call <see cref="GetQueueAsync"/> and notices the hold missing from
  /// <see cref="AutomodQueue.Pending"/>, which never fell out and instead moved to
  /// <see cref="AutomodQueue.RecentlyResolved"/>. Deliberately NOT called from inside
  /// <see cref="GetQueueAsync"/> any more (the reverse of legacy's <c>getAutomodQueue</c>, which
  /// swept in-place) — see <see cref="GetQueueAsync"/>'s doc comment.
  /// </para>
  /// </summary>
  Task<IReadOnlyList<AutomodHold>> SweepExpiredHoldsAsync(CancellationToken cancellationToken);

  /// <summary>
  /// Returns: <see cref="AutomodQueue.Pending"/> — the 200 NEWEST unresolved holds, re-sorted
  /// oldest-first for display (selecting oldest-first and capping would drop the newest holds
  /// during a spam wave — the exact ones a moderator needs); <see cref="AutomodQueue.RecentlyResolved"/> —
  /// up to 20 holds resolved within the last 15 minutes, newest-resolved first. Mirrors legacy's
  /// <c>getAutomodQueue</c> constants (<c>PENDING_LIMIT</c>/<c>RESOLVED_HISTORY_LIMIT</c>/
  /// <c>RESOLVED_HISTORY_WINDOW_MS</c>) exactly.
  ///
  /// <para>
  /// Deliberately does NOT sweep expired holds itself — a caller that wants a fresh queue with no
  /// stale pending holds must call <see cref="SweepExpiredHoldsAsync"/> first (see its doc
  /// comment for why: this store cannot broadcast the sweep's resolutions, so the caller needs
  /// the swept list back before it asks for the queue). <c>GetAutomodQueueQueryHandler</c> is the
  /// only production caller and always does both, in that order, so from the API's perspective
  /// <c>GET /api/automod/queue</c> still behaves exactly like legacy's sweep-then-list — this is a
  /// caller-ordering change, not a behavior change.
  /// </para>
  /// </summary>
  Task<AutomodQueue> GetQueueAsync(CancellationToken cancellationToken);
}
