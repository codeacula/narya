using Marten;
using Marten.Services;

using Narya.Core.Sessions;

using Npgsql;

namespace Narya.Database.Sessions;

/// <summary>
/// <see cref="IStreamSessionStore"/> backed by the plain (non-event-sourced)
/// <see cref="StreamSessionDocument"/>/<see cref="StreamSessionChatterDocument"/> documents.
/// Mirrors legacy's <c>streamSession.ts</c>.
///
/// <para>
/// <b>Both write invariants are DATABASE constraints.</b> They used to be pre-checks — re-read
/// inside the write session, and insert if nothing was found — which two concurrent
/// <c>stream.online</c> deliveries could both pass before either wrote. They are now two unique
/// indexes (see <c>NaryaMartenConfig</c>):
/// </para>
///
/// <para>
/// <b>One session per source</b> — a UNIQUE index on <see cref="StreamSessionDocument.Source"/>.
/// The partial index below cannot cover this: a same-source loser is free to CLOSE the winner's row
/// inside its own transaction and then insert a second row for the same stream id, which the open
/// marker never sees. Without the Source index that leaves a zero-length phantom session and splits
/// the stream's chatter accounting across two ids.
/// </para>
///
/// <para>
/// <b>At most one OPEN session</b> — a partial unique index over
/// <see cref="StreamSessionDocument.OpenMarker"/>, covering two DIFFERENT sources going online at
/// once.
/// </para>
///
/// <para>
/// Either rejection is treated by <see cref="GetOrStartSessionAsync"/> as the benign "someone else
/// already opened it" case, returning the winner rather than surfacing a failure — Twitch
/// redelivers <c>stream.online</c> as a matter of course. The
/// close-the-previous-session-then-open-a-new-one restart path still commits as ONE transaction, so
/// a reader never observes two open sessions or a source with zero.
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

    var created = new StreamSessionDocument
    {
      Id = Guid.NewGuid().ToString(),
      StartedAt = startedAt,
      EndedAt = null,
      Source = source,
    };

    // ONE explicit Postgres transaction, with the close flushed BEFORE the insert inside it. The
    // ordering matters and Marten's own unit of work will not guarantee it: left to one
    // SaveChangesAsync, the close (an update) and the open (an insert) are batched together and
    // the insert can reach the unique index while the previous session is still marked open,
    // failing a restart that is entirely legitimate. Two SaveChangesAsync calls enlisted in one
    // externally-owned transaction give the statement order without giving up atomicity: a reader
    // still never observes two open sessions, nor a source with zero.
    await using var connection = store.Storage.Database.CreateConnection();
    await connection.OpenAsync(cancellationToken).ConfigureAwait(false);
    // READ COMMITTED, stated explicitly to match the advisory-locked transactions in
    // AutomationRunStore/ActionStore/AutomationTriggerStore rather than relying on Npgsql's
    // ReadCommitted default for IsolationLevel.Unspecified. Npgsql does NOT inherit the server's
    // default_transaction_isolation, so this is defense against a future driver-default change,
    // not against a hardened server. The read-then-write below wants the per-statement snapshot
    // for the same reason its siblings do.
    await using var transaction = await connection
      .BeginTransactionAsync(System.Data.IsolationLevel.ReadCommitted, cancellationToken)
      .ConfigureAwait(false);
    await using var session = store.LightweightSession(SessionOptions.ForTransaction(transaction));

    var openSessions = await session.Query<StreamSessionDocument>()
      .Where(s => s.EndedAt == null)
      .ToListAsync(cancellationToken);

    foreach (var open in openSessions)
    {
      session.Store(open with { EndedAt = startedAt });
    }

    await session.SaveChangesAsync(cancellationToken);

    session.Insert(created);

    try
    {
      await session.SaveChangesAsync(cancellationToken);
      await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
    }
    catch (Exception ex) when (IsUniqueViolation(ex))
    {
      // A concurrent stream.online won the race — either for this same source (the Source unique
      // index) or by opening a session of its own first (the OpenMarker partial unique index).
      // That is the NORMAL case for a Twitch redelivery, not an error — roll this attempt back and
      // report the winner. Re-read outside the aborted transaction: everything this transaction did
      // (the close above included) is gone, so the winner's row is the whole truth. FindBySource
      // first, so a same-source loser hands back the very session it was asked for.
      await transaction.RollbackAsync(cancellationToken).ConfigureAwait(false);
      var winner = await FindBySourceAsync(source, cancellationToken).ConfigureAwait(false)
        ?? await FindOpenAsync(cancellationToken).ConfigureAwait(false);

      // A winner that is already gone (closed and superseded between the violation and this read)
      // leaves nothing truthful to return, and inventing a session the store does not hold would
      // be worse than surfacing it — the caller retries the next stream.online delivery.
      return winner is null
        ? throw new InvalidOperationException($"Stream session for source '{source}' lost the open-session race but no open session exists.")
        : (StreamSession)winner;
    }

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

  private async Task<StreamSessionDocument?> FindOpenAsync(CancellationToken cancellationToken)
  {
    await using var session = store.QuerySession();
    return await session.Query<StreamSessionDocument>()
      .Where(s => s.EndedAt == null)
      .OrderByDescending(s => s.StartedAt)
      .FirstOrDefaultAsync(cancellationToken);
  }

  /// <summary>
  /// Walks the exception chain (Marten wraps the underlying Postgres failure) looking for SQLSTATE
  /// 23505 — here, either the unique index on <see cref="StreamSessionDocument.Source"/> rejecting a
  /// second session for one stream id, or the partial unique index on
  /// <see cref="StreamSessionDocument.OpenMarker"/> rejecting a second OPEN session. Both are the
  /// same benign lost-the-race outcome for the caller. Identical pattern to
  /// <c>Narya.Database.Automation.AutomationRunStore.IsUniqueViolation</c>.
  /// </summary>
  private static bool IsUniqueViolation(Exception error)
  {
    for (var current = error; current is not null; current = current.InnerException)
    {
      if (current is PostgresException { SqlState: PostgresErrorCodes.UniqueViolation })
      {
        return true;
      }
    }

    return false;
  }
}
