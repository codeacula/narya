using Marten;

using Narya.Core.Sessions;

namespace Narya.Database.Sessions;

/// <summary>
/// <see cref="IStreamSessionStore"/> backed by the plain (non-event-sourced)
/// <see cref="StreamSessionDocument"/>/<see cref="StreamSessionChatterDocument"/> documents.
/// Mirrors legacy's <c>streamSession.ts</c>.
///
/// <para>
/// <b>The one-active-session invariant.</b> <see cref="GetOrStartSessionAsync"/> is the only
/// place a session is created, and it enforces "at most one open session" itself rather than
/// relying on a database constraint: within a single <see cref="IDocumentSession"/> it
/// re-checks for an existing row with the same <see cref="StreamSessionDocument.Source"/> (in
/// case one was created between the caller's initial read and this method opening its write
/// session — mirroring legacy's re-check inside its <c>db.transaction</c>), then closes every
/// currently-open session before inserting the new one, and finally commits all of it as one
/// <c>SaveChangesAsync</c> — so a reader can never observe two open sessions or a source with
/// zero open sessions after a legitimate stream restart.
/// </para>
///
/// <para>
/// <b>Marten dedup = load-check-then-insert.</b> <c>IDocumentSession.Store</c> upserts
/// (overwrites silently), which would make a redelivered chatter/session write look like a
/// fresh one. Every insert-or-ignore write here (<see cref="RecordCurrentSessionChatterAsync"/>)
/// therefore loads by id first and only inserts on a genuine miss, matching legacy's SQLite
/// <c>insert or ignore</c> semantics (first write wins).
/// </para>
/// </summary>
public sealed class StreamSessionStore(IDocumentStore store) : IStreamSessionStore
{
  public async Task<StreamSession?> GetActiveSessionAsync(CancellationToken cancellationToken)
  {
    await using var session = store.QuerySession();
    var doc = await session.Query<StreamSessionDocument>()
      .Where(s => s.EndedAt == null)
      .OrderByDescending(s => s.StartedAt)
      .FirstOrDefaultAsync(cancellationToken);

    return doc is null ? null : (StreamSession)doc;
  }

  public async Task<string?> GetCurrentSessionIdAsync(CancellationToken cancellationToken)
  {
    var active = await GetActiveSessionAsync(cancellationToken);
    return active?.Id;
  }

  public async Task<StreamSession> GetOrStartSessionAsync(string source, DateTimeOffset startedAt, CancellationToken cancellationToken)
  {
    var existing = await FindBySourceAsync(source, cancellationToken);
    if (existing is not null)
    {
      return (StreamSession)existing;
    }

    await using var session = store.LightweightSession();

    // Re-check inside the write session — see the class doc comment for why.
    var duplicate = await session.Query<StreamSessionDocument>()
      .FirstOrDefaultAsync(s => s.Source == source, cancellationToken);
    if (duplicate is not null)
    {
      return (StreamSession)duplicate;
    }

    var openSessions = await session.Query<StreamSessionDocument>()
      .Where(s => s.EndedAt == null)
      .ToListAsync(cancellationToken);

    foreach (var open in openSessions)
    {
      session.Store(open with { EndedAt = startedAt });
    }

    var created = new StreamSessionDocument
    {
      Id = Guid.NewGuid().ToString(),
      StartedAt = startedAt,
      EndedAt = null,
      Source = source,
    };
    session.Insert(created);

    await session.SaveChangesAsync(cancellationToken);

    return (StreamSession)created;
  }

  public async Task EndActiveSessionAsync(DateTimeOffset endedAt, CancellationToken cancellationToken)
  {
    await using var session = store.LightweightSession();
    var open = await session.Query<StreamSessionDocument>()
      .Where(s => s.EndedAt == null)
      .ToListAsync(cancellationToken);

    foreach (var doc in open)
    {
      session.Store(doc with { EndedAt = endedAt });
    }

    await session.SaveChangesAsync(cancellationToken);
  }

  public async Task<SessionChatterResult> RecordCurrentSessionChatterAsync(
    string login, string messageId, DateTimeOffset occurredAt, CancellationToken cancellationToken)
  {
    var sessionId = await GetCurrentSessionIdAsync(cancellationToken);
    if (sessionId is null)
    {
      return new SessionChatterResult(null, false);
    }

    var loginKey = login.ToLowerInvariant();
    var id = $"{sessionId}:{loginKey}";

    await using var session = store.LightweightSession();
    var existing = await session.LoadAsync<StreamSessionChatterDocument>(id, cancellationToken);
    if (existing is not null)
    {
      return new SessionChatterResult(sessionId, false);
    }

    session.Insert(new StreamSessionChatterDocument
    {
      Id = id,
      SessionId = sessionId,
      Login = loginKey,
      FirstMessageId = messageId,
      FirstSeenAt = occurredAt,
    });
    await session.SaveChangesAsync(cancellationToken);

    return new SessionChatterResult(sessionId, true);
  }

  public async Task<int> GetSessionChatterCountAsync(CancellationToken cancellationToken)
  {
    var sessionId = await GetCurrentSessionIdAsync(cancellationToken);
    if (sessionId is null)
    {
      return 0;
    }

    await using var session = store.QuerySession();
    return await session.Query<StreamSessionChatterDocument>()
      .Where(c => c.SessionId == sessionId)
      .CountAsync(cancellationToken);
  }

  private async Task<StreamSessionDocument?> FindBySourceAsync(string source, CancellationToken cancellationToken)
  {
    await using var session = store.QuerySession();
    return await session.Query<StreamSessionDocument>()
      .FirstOrDefaultAsync(s => s.Source == source, cancellationToken);
  }
}
