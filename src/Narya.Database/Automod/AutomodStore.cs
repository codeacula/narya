using System.Text.Json;

using Marten;

using Narya.Core.Automod;
using Narya.Core.Chat;

namespace Narya.Database.Automod;

/// <summary>
/// <see cref="IAutomodStore"/> backed by the plain (non-event-sourced)
/// <see cref="AutomodHoldDocument"/> — mirrors legacy's <c>automod.ts</c>.
///
/// <para>
/// <b>Marten dedup = load-check-then-insert.</b> See
/// <c>Narya.Database.Chat.ChatStore.TryInsertMessageAsync</c>'s doc comment for why
/// <see cref="RecordHoldAsync"/> loads by id before inserting rather than using
/// <c>IDocumentSession.Store</c>, which would silently overwrite a redelivery on top of the
/// original.
/// </para>
///
/// <para>
/// <b>The three-way idempotency.</b> <see cref="ResolveHoldAsync"/> is the only place a hold's
/// resolution is written, and — like <c>StreamSessionStore.GetOrStartSessionAsync</c>'s
/// one-active-session invariant — it enforces the rule itself, atomically inside a single
/// <see cref="IDocumentSession"/>: load, decide (unresolved, or an authoritative overturn of a
/// speculative expiry), conditionally write, all before <c>SaveChangesAsync</c>. See
/// <see cref="IAutomodStore.ResolveHoldAsync"/>'s doc comment for the exact rule.
/// </para>
///
/// <para>
/// <b>The chat_events audit trail lives here, not in the caller.</b> Unlike
/// <c>Narya.Database.Chat.ChatStore</c>/<c>Narya.Database.Events.StreamEventStore</c> (whose
/// callers in Narya.Application decide when to append a ledger row), this store appends
/// <c>automod.hold</c>/<c>automod.resolve</c> rows itself via the injected
/// <see cref="IChatStore"/> — matching legacy's <c>recordAutomodHold</c>/<c>resolveAutomodHold</c>,
/// which call <c>appendChatEvent</c> inline rather than leaving it to <c>eventsub.ts</c>/<c>routes.ts</c>.
/// </para>
/// </summary>
public sealed class AutomodStore(IDocumentStore store, IChatStore chatStore, TimeProvider timeProvider) : IAutomodStore
{
  /// <summary>Matches legacy's <c>RESOLVED_HISTORY_WINDOW_MS</c>.</summary>
  private static readonly TimeSpan ResolvedHistoryWindow = TimeSpan.FromMinutes(15);

  /// <summary>Matches legacy's <c>RESOLVED_HISTORY_LIMIT</c>.</summary>
  private const int ResolvedHistoryLimit = 20;

  /// <summary>Matches legacy's <c>PENDING_LIMIT</c> — a safety cap so a hold-spam wave can't make the pending payload unbounded.</summary>
  private const int PendingLimit = 200;

  /// <summary>
  /// Matches legacy's <c>HOLD_EXPIRY_WINDOW_MS</c>. Twitch auto-expires held messages well
  /// inside an hour; this conservative bound catches a hold whose <c>update</c> event this
  /// process missed.
  /// </summary>
  private static readonly TimeSpan HoldExpiryWindow = TimeSpan.FromHours(2);

  public async Task<bool> RecordHoldAsync(AutomodHold hold, CancellationToken cancellationToken)
  {
    await using var session = store.LightweightSession();

    var existing = await session.LoadAsync<AutomodHoldDocument>(hold.Id, cancellationToken);
    if (existing is not null)
    {
      return false;
    }

    session.Insert(new AutomodHoldDocument
    {
      Id = hold.Id,
      Channel = hold.Channel,
      Username = hold.Username,
      DisplayName = hold.DisplayName,
      Message = hold.Message,
      Category = hold.Category,
      Level = hold.Level,
      HeldAt = hold.HeldAt,
      ResolvedAt = null,
      Resolution = null,
      ResolvedBy = null,
    });
    await session.SaveChangesAsync(cancellationToken);

    _ = await chatStore.AppendChatEventAsync(
      "automod.hold",
      hold.Channel,
      JsonSerializer.Serialize(hold),
      hold.Id,
      hold.Username,
      hold.HeldAt,
      cancellationToken).ConfigureAwait(false);

    return true;
  }

  public async Task<AutomodResolveResult> ResolveHoldAsync(
    string id, string resolution, string? resolvedBy, bool authoritative, CancellationToken cancellationToken)
  {
    await using var session = store.LightweightSession();

    var existing = await session.LoadAsync<AutomodHoldDocument>(id, cancellationToken);
    if (existing is null)
    {
      return new AutomodResolveResult(null, false);
    }

    var isUnresolved = existing.ResolvedAt is null;
    // An authoritative verdict (Twitch's own automod.message.update, or a successful allow/deny
    // Helix call) is allowed to replace a speculatively-recorded "expired" — but only once: once
    // the resolution is no longer "expired", this branch is false forever, so two authoritative
    // outcomes racing each other stay idempotent (first one to reach this line wins).
    var supersedesProvisionalExpiry = authoritative
      && existing.Resolution == "expired"
      && resolution != "expired";

    if (!isUnresolved && !supersedesProvisionalExpiry)
    {
      return new AutomodResolveResult(ToAutomodHold(existing), false);
    }

    var resolvedAt = timeProvider.GetUtcNow();
    var updated = existing with
    {
      ResolvedAt = resolvedAt,
      Resolution = resolution,
      ResolvedBy = resolvedBy,
    };

    session.Store(updated);
    await session.SaveChangesAsync(cancellationToken);

    _ = await chatStore.AppendChatEventAsync(
      "automod.resolve",
      updated.Channel,
      JsonSerializer.Serialize(new { resolution, resolvedBy }),
      id,
      updated.Username,
      resolvedAt,
      cancellationToken).ConfigureAwait(false);

    return new AutomodResolveResult(ToAutomodHold(updated), true);
  }

  public async Task<AutomodHold?> GetHoldAsync(string id, CancellationToken cancellationToken)
  {
    await using var session = store.QuerySession();
    var doc = await session.LoadAsync<AutomodHoldDocument>(id, cancellationToken);
    return doc is null ? null : ToAutomodHold(doc);
  }

  public async Task<IReadOnlyList<AutomodHold>> SweepExpiredHoldsAsync(CancellationToken cancellationToken)
  {
    var cutoff = timeProvider.GetUtcNow() - HoldExpiryWindow;

    await using var session = store.QuerySession();
    var stale = await session.Query<AutomodHoldDocument>()
      .Where(h => h.ResolvedAt == null && h.HeldAt < cutoff)
      .ToListAsync(cancellationToken);

    // Reuses ResolveHoldAsync (each a separate session/transaction) so every swept hold still
    // gets its own audit-trail row and the same idempotency guarantee — matches legacy's
    // sweepExpiredHolds, which loops calling resolveAutomodHold per stale id. Collects only the
    // holds THIS call actually changed to expired (Changed: true) — a stale doc that a concurrent
    // session already resolved out from under this sweep is silently skipped rather than reported
    // as swept, since this store has no mediator to broadcast a resolution that didn't happen here.
    var swept = new List<AutomodHold>(stale.Count);
    foreach (var doc in stale)
    {
      var result = await ResolveHoldAsync(doc.Id, "expired", null, authoritative: false, cancellationToken).ConfigureAwait(false);
      if (result is { Changed: true, Hold: not null })
      {
        swept.Add(result.Hold);
      }
    }

    return swept;
  }

  public async Task<AutomodQueue> GetQueueAsync(CancellationToken cancellationToken)
  {
    var cutoff = timeProvider.GetUtcNow() - ResolvedHistoryWindow;

    await using var session = store.QuerySession();

    // Take the NEWEST holds up to the cap, then flip them back to oldest-first for display —
    // selecting oldest-first and capping would drop the newest holds, the exact ones a moderator
    // needs during a spam wave. Matches legacy's listPendingAutomodHolds subquery.
    var pendingNewestFirst = await session.Query<AutomodHoldDocument>()
      .Where(h => h.ResolvedAt == null)
      .OrderByDescending(h => h.HeldAt)
      .Take(PendingLimit)
      .ToListAsync(cancellationToken);

    var recentlyResolved = await session.Query<AutomodHoldDocument>()
      .Where(h => h.ResolvedAt != null && h.ResolvedAt >= cutoff)
      .OrderByDescending(h => h.ResolvedAt)
      .Take(ResolvedHistoryLimit)
      .ToListAsync(cancellationToken);

    return new AutomodQueue(
      Pending: [.. pendingNewestFirst.OrderBy(h => h.HeldAt).Select(ToAutomodHold)],
      RecentlyResolved: [.. recentlyResolved.Select(ToAutomodHold)]);
  }

  private static AutomodHold ToAutomodHold(AutomodHoldDocument doc) => new(
    Id: doc.Id,
    Channel: doc.Channel,
    Username: doc.Username,
    DisplayName: doc.DisplayName,
    Message: doc.Message,
    Category: doc.Category,
    Level: doc.Level,
    HeldAt: doc.HeldAt,
    ResolvedAt: doc.ResolvedAt,
    Resolution: doc.Resolution,
    ResolvedBy: doc.ResolvedBy);
}
