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
  /// The resolution rule:
  /// <list type="bullet">
  /// <item>Unknown <paramref name="id"/> → <c>{ Hold: null, Changed: false }</c>.</item>
  /// <item>An unresolved hold → always resolves: sets <c>ResolvedAt</c> to now, <c>Resolution</c>
  /// to <paramref name="resolution"/>, <c>ResolvedBy</c> to <paramref name="resolvedBy"/>, and
  /// records <paramref name="source"/> as the resolution's provenance.</item>
  /// <item>An already-resolved hold → returned UNCHANGED (<c>Changed: false</c>) UNLESS
  /// <paramref name="source"/> STRICTLY OUTRANKS the stored source (see
  /// <see cref="AutomodResolutionSource"/>) AND <paramref name="resolution"/> actually differs
  /// from the stored one. So a real verdict overturns a speculative expiry exactly once (the
  /// pre-existing behavior), and — new — an EventSub verdict overturns a contradictory dashboard
  /// one, while a dashboard verdict never overturns an EventSub one.</item>
  /// </list>
  /// On an actual write, also appends an <c>automod.resolve</c> row to the <c>chat_events</c>
  /// ledger via the injected <c>Narya.Core.Chat.IChatStore</c> — same "the store does its own
  /// audit trail" pattern as <see cref="RecordHoldAsync"/>. Only the resolution that actually won
  /// appends; a losing one appends nothing, so the audit trail can never hold two contradictory
  /// verdicts for one hold.
  ///
  /// <para>
  /// <b>This is enforced against concurrent callers, not just sequential ones.</b> The decision
  /// and the write it gates are one optimistically-concurrent read-modify-write: the stored
  /// document carries a version, the update only lands if the version is still the one that was
  /// read, and a loser re-reads and re-applies the rule above against the winner's state. Two
  /// callers racing (the HTTP allow/deny route and a concurrent EventSub dispatch) therefore
  /// converge on the SAME stored verdict regardless of arrival order — the higher-precedence
  /// source's — rather than on whichever happened to save last.
  /// </para>
  /// </summary>
  Task<AutomodResolveResult> ResolveHoldAsync(
    string id, string resolution, string? resolvedBy, AutomodResolutionSource source, CancellationToken cancellationToken);

  /// <summary>The stored hold for <paramref name="id"/>, or null if none exists.</summary>
  Task<AutomodHold?> GetHoldAsync(string id, CancellationToken cancellationToken);

  /// <summary>
  /// Resolves every unresolved hold whose <see cref="AutomodHold.HeldAt"/> is older than the
  /// hold-expiry window (2 hours) as <c>"expired"</c>, with
  /// <see cref="AutomodResolutionSource.Speculative"/> provenance — so a later real verdict
  /// (a <see cref="AutomodResolutionSource.Dashboard"/> or
  /// <see cref="AutomodResolutionSource.EventSub"/> <see cref="ResolveHoldAsync"/> call) can still
  /// overturn it exactly once. Mirrors legacy's <c>sweepExpiredHolds</c>: Twitch auto-expires held messages well
  /// inside an hour, so this is a conservative safety net for a hold whose <c>update</c> event
  /// this process missed (a socket drop, or downtime), reusing <see cref="ResolveHoldAsync"/> so
  /// each swept hold still gets its own audit-trail row and idempotency guarantees.
  ///
  /// <para>
  /// Returns exactly the holds this call actually swept to <c>"expired"</c> (never one that a
  /// concurrent caller resolved first — <see cref="ResolveHoldAsync"/> reports that loss as
  /// <c>Changed: false</c>). This store is deliberately mediator-free (see this
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
