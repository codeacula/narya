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
    await using var session = store.QuerySession();
    var db = await session.LoadAsync<DbTwitchToken>(StreamIdFor(provider), cancellationToken);
    return Result.Ok(db is null ? null : (TwitchToken?)db);
  }

  public Task<Result> SaveAsync(TwitchProvider provider, TwitchToken token, CancellationToken cancellationToken)
  {
    var ev = new TwitchTokenUpdatedEvent
    {
      EventId = Guid.NewGuid(),
      OccurredAt = DateTimeOffset.UtcNow,
      AccessToken = token.AccessToken,
      RefreshToken = token.RefreshToken,
      Scopes = token.Scopes,
      TokenType = token.TokenType,
      ExpiresAt = token.ExpiresAt,
    };

    return AppendAsync(provider, ev, cancellationToken);
  }

  public Task<Result> DeleteAsync(TwitchProvider provider, CancellationToken cancellationToken)
  {
    var ev = new TwitchTokenClearedEvent
    {
      EventId = Guid.NewGuid(),
      OccurredAt = DateTimeOffset.UtcNow,
    };

    return AppendAsync(provider, ev, cancellationToken);
  }

  private async Task<Result> AppendAsync(TwitchProvider provider, object ev, CancellationToken cancellationToken)
  {
    var streamId = StreamIdFor(provider);

    await using var session = store.LightweightSession();
    var streamState = await session.Events.FetchStreamStateAsync(streamId, cancellationToken);

    _ = streamState is null
      ? session.Events.StartStream<DbTwitchToken>(streamId, ev)
      : session.Events.Append(streamId, ev);

    await session.SaveChangesAsync(cancellationToken);

    return Result.Ok();
  }
}
