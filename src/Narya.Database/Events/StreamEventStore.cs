using Marten;

using Narya.Core.Events;

namespace Narya.Database.Events;

/// <summary>
/// <see cref="IStreamEventStore"/> backed by the plain (non-event-sourced)
/// <see cref="StreamEventDocument"/> — mirrors legacy's <c>eventsub.ts</c>/<c>dashboard/status.ts</c>.
///
/// <b>Marten dedup = load-check-then-insert.</b> See
/// <c>Narya.Database.Chat.ChatStore.TryInsertMessageAsync</c>'s doc comment for why
/// <see cref="InsertAsync"/> loads by id before inserting rather than using
/// <c>IDocumentSession.Store</c>, which would silently overwrite a redelivery on top of the
/// original.
/// </summary>
public sealed class StreamEventStore(IDocumentStore store) : IStreamEventStore
{
  public async Task<bool> InsertAsync(StreamEvent streamEvent, CancellationToken cancellationToken)
  {
    await using var session = store.LightweightSession();

    var existing = await session.LoadAsync<StreamEventDocument>(streamEvent.Id, cancellationToken);
    if (existing is not null)
    {
      return false;
    }

    session.Insert(new StreamEventDocument
    {
      Id = streamEvent.Id,
      Kind = streamEvent.Kind,
      Actor = streamEvent.Actor,
      Detail = streamEvent.Detail,
      Tone = streamEvent.Tone,
      ReceivedAt = streamEvent.ReceivedAt,
      SessionId = streamEvent.SessionId,
      ActorLogin = streamEvent.ActorLogin,
    });
    await session.SaveChangesAsync(cancellationToken);

    return true;
  }

  public async Task UpdateDetailToneAsync(string id, string detail, string tone, CancellationToken cancellationToken)
  {
    await using var session = store.LightweightSession();

    var existing = await session.LoadAsync<StreamEventDocument>(id, cancellationToken);
    if (existing is null)
    {
      return;
    }

    session.Store(existing with { Detail = detail, Tone = tone });
    await session.SaveChangesAsync(cancellationToken);
  }

  public async Task<IReadOnlyList<StreamEvent>> GetRecentAsync(int limit, CancellationToken cancellationToken)
  {
    await using var session = store.QuerySession();
    var docs = await session.Query<StreamEventDocument>()
      .OrderByDescending(e => e.ReceivedAt)
      .Take(limit)
      .ToListAsync(cancellationToken);

    return [.. docs.Select(ToStreamEvent)];
  }

  private static StreamEvent ToStreamEvent(StreamEventDocument doc) => new(
    Id: doc.Id,
    Kind: doc.Kind,
    Actor: doc.Actor,
    Detail: doc.Detail,
    Tone: doc.Tone,
    ReceivedAt: doc.ReceivedAt,
    ActorLogin: doc.ActorLogin,
    SessionId: doc.SessionId,
    Ago: null);
}
