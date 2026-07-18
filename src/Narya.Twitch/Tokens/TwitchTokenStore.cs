using FluentResults;

using Marten;

using Narya.Twitch.Tokens.Events;

namespace Narya.Twitch.Tokens;

/// <summary>
/// One Marten stream per <see cref="TwitchProvider"/>, each keyed by a fixed
/// deterministic Guid — mirrors <c>AppConfigStore.RootId</c>'s singleton-stream pattern,
/// just one stream per provider instead of one stream for the whole deployment. A
/// disconnect (<see cref="DeleteAsync"/>) appends a <see cref="TwitchTokenClearedEvent"/>
/// rather than deleting the stream, so re-authenticating later resumes the same stream
/// instead of starting a fresh one.
///
/// <para>
/// Each provider's token is stored in two halves sharing the one
/// <see cref="StreamIdFor"/> identity: non-secret metadata (scopes, token type, expiry) is
/// event-sourced on the stream, while the access/refresh tokens live in
/// <see cref="DbTwitchTokenSecrets"/>, a plain document overwritten on save and HARD
/// DELETED on disconnect. An append-only stream could not erase them — and
/// <c>TwitchCredentials.RefreshAndSaveAsync</c> saves on every refresh, so the stream
/// would otherwise accumulate one plaintext credential set per refresh. Both halves are
/// written through the same <c>IDocumentSession</c> and committed by one
/// <c>SaveChangesAsync</c>.
/// </para>
///
/// <para>
/// NOT implemented, matching legacy: disconnect does not call Twitch's token-revocation
/// endpoint. Deleting the local secrets document erases OUR copy, but a refresh token that
/// leaked before the disconnect stays live at Twitch until the operator revokes the app's
/// access there.
/// </para>
/// </summary>
public sealed class TwitchTokenStore(IDocumentStore store) : ITwitchTokenStore
{
  private static readonly Guid BroadcasterStreamId = Guid.Parse("00000000-0000-0000-0000-0000000000a1");
  private static readonly Guid BotStreamId = Guid.Parse("00000000-0000-0000-0000-0000000000a2");

  public static Guid StreamIdFor(TwitchProvider provider) => provider switch
  {
    TwitchProvider.Broadcaster => BroadcasterStreamId,
    TwitchProvider.Bot => BotStreamId,
    _ => throw new ArgumentOutOfRangeException(nameof(provider), provider, "Unknown Twitch provider."),
  };

  public async Task<Result<TwitchToken?>> GetAsync(TwitchProvider provider, CancellationToken cancellationToken)
  {
    var streamId = StreamIdFor(provider);

    await using var session = store.QuerySession();
    var db = await session.LoadAsync<DbTwitchToken>(streamId, cancellationToken);

    if (db is null)
    {
      return Result.Ok<TwitchToken?>(null);
    }

    var secrets = await session.LoadAsync<DbTwitchTokenSecrets>(streamId, cancellationToken);
    return Result.Ok(db.ToDomain(secrets));
  }

  public Task<Result> SaveAsync(TwitchProvider provider, TwitchToken token, CancellationToken cancellationToken)
  {
    var ev = new TwitchTokenUpdatedEvent
    {
      EventId = Guid.NewGuid(),
      OccurredAt = DateTimeOffset.UtcNow,
      Scopes = token.Scopes,
      TokenType = token.TokenType,
      ExpiresAt = token.ExpiresAt,
    };

    // A save always replaces the whole token, so the secrets document is a straight
    // overwrite — no null-means-unchanged folding, unlike AppConfig's patch semantics.
    var secrets = new DbTwitchTokenSecrets
    {
      Id = StreamIdFor(provider),
      AccessToken = token.AccessToken,
      RefreshToken = token.RefreshToken,
    };

    return WriteAsync(provider, ev, session => session.Store(secrets), cancellationToken);
  }

  public Task<Result> DeleteAsync(TwitchProvider provider, CancellationToken cancellationToken)
  {
    var ev = new TwitchTokenClearedEvent
    {
      EventId = Guid.NewGuid(),
      OccurredAt = DateTimeOffset.UtcNow,
    };

    // The cleared event is kept (connect/disconnect audit trail), but the secret half is
    // physically deleted in the same transaction — this is the erasure legacy got from
    // `delete from twitch_oauth where provider = ?`.
    return WriteAsync(
      provider,
      ev,
      session => session.Delete<DbTwitchTokenSecrets>(StreamIdFor(provider)),
      cancellationToken);
  }

  private async Task<Result> WriteAsync(
    TwitchProvider provider,
    object ev,
    Action<IDocumentSession> applySecrets,
    CancellationToken cancellationToken)
  {
    var streamId = StreamIdFor(provider);

    await using var session = store.LightweightSession();
    var streamState = await session.Events.FetchStreamStateAsync(streamId, cancellationToken);

    _ = streamState is null
      ? session.Events.StartStream<DbTwitchToken>(streamId, ev)
      : session.Events.Append(streamId, ev);

    applySecrets(session);

    await session.SaveChangesAsync(cancellationToken);

    return Result.Ok();
  }
}
