namespace Narya.Core.Events;

/// <summary>
/// Stream-event persistence — a port of legacy's <c>stream_events</c> table
/// (<c>legacy/src/server/eventsub.ts</c>'s <c>insertStreamEvent</c>/<c>updateStreamEventDetail</c>,
/// <c>legacy/src/server/dashboard/status.ts</c>'s <c>GET /api/dashboard/events</c>). Implemented
/// by <c>Narya.Database.Events.StreamEventStore</c>.
///
/// Deliberately defined here (Narya.Core), not alongside its implementation in Narya.Database:
/// <c>Narya.Application.Events.PersistStreamEventHandler</c>/<c>UpdateStreamEventHandler</c> are
/// the consumers, and Narya.Application deliberately does not reference Narya.Database — the
/// same reference-direction constraint documented on <see cref="StreamEvent"/> and
/// <c>Narya.Core.Chat.IChatStore</c>. Registered as
/// <c>AddSingleton&lt;IStreamEventStore, StreamEventStore&gt;</c> in
/// <c>Narya.Database.ServiceCollectionExtensions.AddNaryaDatabase</c>.
/// </summary>
public interface IStreamEventStore
{
  /// <summary>
  /// Insert-or-ignore keyed by <see cref="StreamEvent.Id"/> — load-check-then-insert, matching
  /// <c>Narya.Database.Chat.ChatStore.TryInsertMessageAsync</c>'s pattern (never
  /// <c>session.Store</c>, which would silently overwrite a redelivery on top of the original).
  /// Returns <see langword="true"/> only on a genuine first insert; a redelivered id returns
  /// <see langword="false"/> and leaves the stored row untouched. <see cref="StreamEvent.Ago"/> is
  /// never persisted — the store ignores it on write and never populates it on read (see
  /// <c>Narya.Database.Events.StreamEventDocument</c>, which has no <c>Ago</c> column).
  /// </summary>
  Task<bool> InsertAsync(StreamEvent streamEvent, CancellationToken cancellationToken);

  /// <summary>
  /// Updates the stored row's <c>Detail</c>/<c>Tone</c> — the subscribe/subscription.message
  /// merge (see <see cref="StreamEventUpdate"/>'s doc comment). A no-op when <paramref name="id"/>
  /// does not match a stored event (matches legacy's SQLite <c>update</c>, a silent no-op on zero
  /// matched rows).
  /// </summary>
  Task UpdateDetailToneAsync(string id, string detail, string tone, CancellationToken cancellationToken);

  /// <summary>
  /// The <paramref name="limit"/> most-recent stream events, most-recent
  /// (<see cref="StreamEvent.ReceivedAt"/>) first — a port of legacy's
  /// <c>GET /api/dashboard/events</c> (<c>order by received_at desc limit 50</c>, no reversal:
  /// unlike <c>Narya.Core.Chat.IChatStore.GetRecentMessagesAsync</c>, this route is never
  /// displayed oldest-first). <see cref="StreamEvent.Ago"/> is always <see langword="null"/> on
  /// the returned events — <c>GetRecentStreamEventsQueryHandler</c> computes it.
  /// </summary>
  Task<IReadOnlyList<StreamEvent>> GetRecentAsync(int limit, CancellationToken cancellationToken);
}
